/*
 * Data for the coin-type page. One function, one round trip: every query goes out in a single
 * D1 batch. Column names mirror pipeline/schema.sql, the contract with the pipeline.
 */
import type { LegendSegment } from "@/components/legend"
import { iiif, imageLicence, secure, yearRange, type Licence } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import { CARD_SELECT, card, type CardRow, type TypeCardData } from "@/lib/typeCards"

export type { TypeCardData }

const RELATED_LIMIT = 8

type Side = "obverse" | "reverse"

export type Link = { id: string; name: string }
export type Person = Link & { role: string; years: string | null }
export type Photo = { src: string; side: Side | "combined" }
export type Credit = { holder: string; licence: Licence | null; url: string }
/** A monogram, control mark or symbol in the field. */
export type FieldMark = {
  id: string
  name: string
  definition: string | null
  /** SVG drawing, when the source has one. */
  image: string | null
  /** Letters the monogram is made of: "Κ Ν Ω". */
  letters: string | null
  uncertain: boolean
}

export type Specimen = {
  id: string
  url: string
  holder: string
  identifier: string | null
  weight: number | null
  diameter: number | null
  dieAxis: number | null
  /** Small images for table rows. */
  thumbs: Photo[]
  /** Large images for the viewer and the hero. */
  photos: Photo[]
  credit: Credit
}

export type CoinType = {
  id: string
  reference: string
  sourceUri: string
  /** The dataset the type comes from, for "View on OCRE". */
  source: { slug: string; name: string | null }
  /** The type's own catalogue entry: 'RIC II' and '147' of 'RIC II Trajan 147'; `work` is the reference_work id. */
  catalogue: { work: string; label: string; volume: string | null; number: string | null } | null
  /** Its primary collector category with its ancestors, broadest first: Greek, Hellenistic, Seleucid Kingdom. */
  categoryPath: Link[]
  date: string | null
  mint: (Link & { uncertain: boolean }) | null
  /** The source says the mint is uncertain but names none. */
  mintUnknown: boolean
  denominations: Link[]
  materials: string[]
  authorities: Person[]
  /**
   * Rulers named on the coin who did not strike it: posthumous Alexanders, struck in his name by
   * Ptolemy I, by cities, or by no one the catalogue records.
   */
  statedAuthorities: Person[]
  /** People shown on the coin who are not its issuer (an empress, a deified father). */
  portraits: Person[]
  organizations: Link[]
  subjects: (Link & { side: Side })[]
  parent: { id: string; reference: string } | null
  variants: TypeCardData[]
  variantCredits: PhotoCreditItem[]
  sides: {
    side: Side
    legend: string | null
    /** legend.language: 'la', 'grc', 'pgd', 'phn', 'pra', or 'zxx' for a cataloguer's note. */
    language: string | null
    transliteration: string | null
    /** People named in the segments who have a ruler page. */
    rulers: string[]
    description: string | null
    segments: LegendSegment[] | null
    marks: FieldMark[]
  }[]
  hero: Specimen | null
  /** Every specimen of the type, best first; the table sorts and filters them in the browser. */
  specimens: Specimen[]
  specimenCount: number
  collectionCount: number
  related: TypeCardData[]
  relatedCredits: PhotoCreditItem[]
}

export type CoinTypeResult =
  | { kind: "found"; type: CoinType }
  | { kind: "redirect"; to: string }
  | { kind: "missing" }

type TypeRow = {
  id: string
  title: string | null
  source_uri: string
  dataset_slug: string
  dataset_name: string | null
  ref_work: string | null
  ref_label: string | null
  ref_volume: string | null
  ref_number: string | null
  category_id: string | null
  parent_id: string | null
  replaced_by_id: string | null
  start_year: number | null
  end_year: number | null
  mint_id: string | null
  mint_name: string | null
  mint_uncertain: number
  obv_legend: string | null
  obv_description: string | null
  rev_legend: string | null
  rev_description: string | null
}

type ImageRow = {
  specimen_id: string
  side: Side | "combined"
  url: string
  thumbnail_url: string | null
  iiif_service: string | null
  usable: number
}

/*
 * Specimens worth showing first: photos that load, both sides photographed, then a single
 * combined photo, then the rest; within that, IIIF (sharp at any size) and measured coins first.
 */
const SPECIMEN_ORDER = `
  ORDER BY
    (SELECT count(*) FROM image WHERE specimen_id = s.id AND usable = 0) > 0,
    (SELECT CASE
       WHEN sum(side = 'obverse') > 0 AND sum(side = 'reverse') > 0 THEN 0
       WHEN sum(side = 'combined') > 0 THEN 1
       ELSE 2 END FROM image WHERE specimen_id = s.id),
    (SELECT count(*) FROM image WHERE specimen_id = s.id AND iiif_service IS NOT NULL) DESC,
    s.weight_g IS NULL,
    s.id`

export async function getCoinType(db: D1Database, id: string): Promise<CoinTypeResult> {
  const t = await db
    .prepare(
      `SELECT t.*, m.name AS mint_name, d.slug AS dataset_slug, d.name AS dataset_name,
         r.work_id AS ref_work, r.label AS ref_label, r.volume AS ref_volume, r.number AS ref_number,
         tc.category_id
       FROM coin_type t
       JOIN dataset d ON d.id = t.dataset_id
       LEFT JOIN mint m ON m.id = t.mint_id
       LEFT JOIN type_reference r ON r.type_id = t.id AND r.is_primary = 1
       LEFT JOIN type_category tc ON tc.type_id = t.id AND tc.is_primary = 1
       WHERE t.id = ?`
    )
    .bind(id)
    .first<TypeRow>()
  if (!t) return { kind: "missing" }
  if (t.replaced_by_id) return { kind: "redirect", to: t.replaced_by_id }

  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args)
  const [people, orgs, denoms, mats, subjects, legends, marks, categories, parent, variants, specimens, imageRows, related] =
    await db.batch([
      q(
        `SELECT p.id, p.name, p.start_year, p.end_year, tp.role FROM type_person tp
         JOIN person p ON p.id = tp.person_id WHERE tp.type_id = ?
         ORDER BY tp.role = 'authority' DESC, tp.role = 'issuer' DESC, p.name`,
        id
      ),
      q(
        `SELECT o.id, o.name FROM type_organization tor JOIN organization o ON o.id = tor.organization_id
         WHERE tor.type_id = ?`,
        id
      ),
      q(`SELECT d.id, d.name FROM type_denomination td JOIN denomination d ON d.id = td.denomination_id WHERE td.type_id = ?`, id),
      q(`SELECT m.name FROM type_material tm JOIN material m ON m.id = tm.material_id WHERE tm.type_id = ?`, id),
      q(
        `SELECT s.id, s.name, ts.side FROM type_subject ts JOIN subject s ON s.id = ts.subject_id
         WHERE ts.type_id = ? ORDER BY ts.side DESC, ts.confidence DESC`,
        id
      ),
      // `rulers`: people the segments name who have a ruler page (every person row does; see lib/ruler.ts).
      q(
        `SELECT side, language, legend, transliteration, segments,
           (SELECT json_group_array(p.id) FROM json_each(CASE WHEN json_valid(l.segments) THEN l.segments ELSE '[]' END) j
            JOIN person p ON p.id = json_extract(j.value, '$.person')) AS rulers
         FROM legend l WHERE type_id = ? ORDER BY id`,
        id
      ),
      q(
        `SELECT ts.side, s.id, s.name, s.definition, s.image_url, s.letters, ts.uncertain
         FROM type_symbol ts JOIN symbol s ON s.id = ts.symbol_id WHERE ts.type_id = ? ORDER BY ts.side, s.id`,
        id
      ),
      // The primary category and its ancestors, broadest first.
      q(
        `WITH RECURSIVE path(id, name, parent_id, depth) AS (
           SELECT id, name, parent_id, 0 FROM category WHERE id = ?
           UNION ALL SELECT c.id, c.name, c.parent_id, p.depth + 1 FROM category c JOIN path p ON c.id = p.parent_id
         )
         SELECT id, name FROM path ORDER BY depth DESC`,
        t.category_id ?? ""
      ),
      q(`SELECT id, title FROM coin_type WHERE id = ?`, t.parent_id ?? ""),
      q(`${CARD_SELECT} WHERE t.parent_id = ? AND t.replaced_by_id IS NULL ORDER BY t.id`, id),
      q(
        `SELECT s.id, s.source_uri, s.identifier, s.weight_g, s.diameter_mm, s.die_axis,
           coalesce(i.name, d.name) AS holder, d.image_licence, d.data_licence
         FROM specimen_type st JOIN specimen s ON s.id = st.specimen_id
         LEFT JOIN institution i ON i.id = s.institution_id
         LEFT JOIN dataset d ON d.id = s.dataset_id
         WHERE st.type_id = ? ${SPECIMEN_ORDER}`,
        id
      ),
      // A join, not an id list: D1 allows at most 100 bound parameters and a type can have thousands of coins.
      q(
        `SELECT i.specimen_id, i.side, i.url, i.thumbnail_url, i.iiif_service, i.usable FROM image i
         JOIN specimen_type st ON st.specimen_id = i.specimen_id WHERE st.type_id = ? ORDER BY i.id`,
        id
      ),
      /*
       * Same ruler and the same reverse legend (one issue), then the same ruler and denomination.
       * The ruler is the type's authority, or failing that the ruler it names: a posthumous
       * Alexander's neighbours are other coins in Alexander's name.
       */
      q(
        `WITH ruler AS (
           SELECT role, person_id FROM type_person WHERE type_id = ?1
             AND role = (SELECT role FROM type_person WHERE type_id = ?1 AND role IN ('authority', 'stated_authority')
                         ORDER BY role = 'authority' DESC LIMIT 1)
         )
         ${CARD_SELECT}
         WHERE t.id != ?1 AND t.replaced_by_id IS NULL
           AND t.id IN (SELECT tp.type_id FROM type_person tp JOIN ruler ON ruler.role = tp.role AND ruler.person_id = tp.person_id)
         ORDER BY t.rev_legend IS NOT ?2,
           t.id NOT IN (SELECT type_id FROM type_denomination
                        WHERE denomination_id IN (SELECT denomination_id FROM type_denomination WHERE type_id = ?1)),
           abs(coalesce(t.start_year, 0) - coalesce(?3, 0)), t.id
         LIMIT ${RELATED_LIMIT}`,
        id,
        t.rev_legend,
        t.start_year
      ),
    ])

  const specimenRows = specimens.results as {
    id: string
    source_uri: string
    identifier: string | null
    weight_g: number | null
    diameter_mm: number | null
    die_axis: number | null
    holder: string | null
    image_licence: string | null
    data_licence: string | null
  }[]

  const imagesBySpecimen = new Map<string, ImageRow[]>()
  for (const row of imageRows.results as ImageRow[]) {
    imagesBySpecimen.set(row.specimen_id, [...(imagesBySpecimen.get(row.specimen_id) ?? []), row])
  }

  /* Obverse and reverse if both exist, else one combined photo. Small sizes prefer the museum's thumbnail. */
  const photosFor = (specimenId: string, box: number, small = false): Photo[] => {
    const rows = (imagesBySpecimen.get(specimenId) ?? []).filter((r) => r.usable)
    const pick = (side: ImageRow["side"]) => rows.find((r) => r.side === side)
    const chosen = [pick("obverse"), pick("reverse")].filter(Boolean) as ImageRow[]
    const list = chosen.length ? chosen : rows.filter((r) => r.side === "combined").slice(0, 1)
    return list
      .map((r) => ({
        side: r.side,
        src: iiif(r.iiif_service, box) ?? (small ? secure(r.thumbnail_url) : null) ?? secure(r.url),
      }))
      .filter((p): p is Photo => !!p.src)
  }

  const toSpecimen = (s: (typeof specimenRows)[number], box: number): Specimen => ({
    id: s.id,
    url: secure(s.source_uri) ?? s.source_uri,
    holder: s.holder ?? "Unknown collection",
    identifier: s.identifier,
    weight: s.weight_g,
    diameter: s.diameter_mm,
    dieAxis: s.die_axis,
    thumbs: photosFor(s.id, 160, true),
    photos: photosFor(s.id, box),
    credit: { holder: s.holder ?? "Unknown collection", licence: imageLicence(s.image_licence, s.data_licence), url: secure(s.source_uri) ?? s.source_uri },
  })

  const peopleRows = people.results as { id: string; name: string; start_year: number | null; end_year: number | null; role: string }[]
  const toPerson = (p: (typeof peopleRows)[number]): Person => ({
    id: p.id,
    name: p.name,
    role: p.role,
    years: yearRange(p.start_year, p.end_year),
  })
  const authorityIds = new Set(peopleRows.filter((p) => p.role === "authority" || p.role === "issuer").map((p) => p.id))
  const authorities = [...new Map(peopleRows.filter((p) => authorityIds.has(p.id)).map((p) => [p.id, toPerson(p)])).values()]
  const statedAuthorities = peopleRows.filter((p) => p.role === "stated_authority" && !authorityIds.has(p.id)).map(toPerson)
  const named = new Set([...authorityIds, ...statedAuthorities.map((p) => p.id)])
  const portraits = [
    ...new Map(
      peopleRows.filter((p) => p.role.startsWith("portrait") && !named.has(p.id)).map((p) => [p.id, toPerson(p)])
    ).values(),
  ]

  const markRows = marks.results as {
    side: Side
    id: string
    name: string
    definition: string | null
    image_url: string | null
    letters: string | null
    uncertain: number
  }[]
  const marksOn = (side: Side): FieldMark[] =>
    markRows
      .filter((m) => m.side === side)
      .map((m) => ({
        id: m.id,
        name: m.name,
        definition: m.definition,
        image: secure(m.image_url),
        letters: m.letters,
        uncertain: !!m.uncertain,
      }))

  const legendRows = legends.results as {
    side: Side
    language: string
    legend: string
    transliteration: string | null
    segments: string | null
    rulers: string | null
  }[]
  const sideData = (side: Side) => {
    const row = legendRows.find((l) => l.side === side)
    let segments: LegendSegment[] | null = null
    try {
      segments = row?.segments ? (JSON.parse(row.segments) as LegendSegment[]) : null
    } catch {
      segments = null
    }
    return {
      side,
      legend: row?.legend ?? (side === "obverse" ? t.obv_legend : t.rev_legend),
      language: row?.language ?? null,
      transliteration: row?.transliteration ?? null,
      rulers: (() => {
        try {
          return JSON.parse(row?.rulers ?? "[]") as string[]
        } catch {
          return []
        }
      })(),
      description: side === "obverse" ? t.obv_description : t.rev_description,
      segments,
      marks: marksOn(side),
    }
  }

  const heroRow = specimenRows.find((s) => photosFor(s.id, 900).length > 0)
  const parentRow = parent.results[0] as { id: string; title: string | null } | undefined

  const variantCards = (variants.results as CardRow[]).map(card)
  const relatedCards = (related.results as CardRow[]).map(card)
  const ids = (cards: TypeCardData[]) => cards.map((c) => c.imageId).filter((i): i is number => i != null)
  const [variantCredits, relatedCredits] = await Promise.all([
    getPhotoCredits(db, ids(variantCards)),
    getPhotoCredits(db, ids(relatedCards)),
  ])

  return {
    kind: "found",
    type: {
      id: t.id,
      reference: t.title ?? t.id,
      sourceUri: secure(t.source_uri) ?? t.source_uri,
      source: { slug: t.dataset_slug, name: t.dataset_name },
      catalogue: t.ref_label ? { work: t.ref_work ?? "", label: t.ref_label, volume: t.ref_volume, number: t.ref_number } : null,
      categoryPath: categories.results as Link[],
      date: yearRange(t.start_year, t.end_year),
      mint: t.mint_id ? { id: t.mint_id, name: t.mint_name ?? t.mint_id, uncertain: !!t.mint_uncertain } : null,
      mintUnknown: !t.mint_id && !!t.mint_uncertain,
      denominations: denoms.results as Link[],
      materials: (mats.results as { name: string }[]).map((m) => m.name),
      authorities,
      statedAuthorities,
      portraits,
      organizations: orgs.results as Link[],
      subjects: subjects.results as (Link & { side: Side })[],
      parent: parentRow ? { id: parentRow.id, reference: parentRow.title ?? parentRow.id } : null,
      variants: variantCards,
      variantCredits,
      sides: [sideData("obverse"), sideData("reverse")].filter((s) => s.legend || s.description || s.marks.length),
      hero: heroRow ? toSpecimen(heroRow, 900) : null,
      specimens: specimenRows.map((s) => toSpecimen(s, 900)),
      specimenCount: specimenRows.length,
      collectionCount: new Set(specimenRows.map((s) => s.holder)).size,
      related: relatedCards,
      relatedCredits,
    },
  }
}
