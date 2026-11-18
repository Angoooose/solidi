/*
 * Data for the coin-type page. One function, one round trip: every query goes out in a single
 * D1 batch. Column names mirror pipeline/schema.sql, the contract with the pipeline.
 */
import type { LegendSegment } from "@/components/legend"
import { iiif, imageLicence, secure, yearRange, type Licence } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import { CARD_SELECT, REFUSING_HOST, card, type CardRow, type TypeCardData } from "@/lib/typeCards"

export type { TypeCardData }

const RELATED_LIMIT = 8

type Side = "obverse" | "reverse"

export type Link = { id: string; name: string }
export type Person = Link & { role: string; years: string | null }
export type Photo = { src: string; side: Side | "combined" }
export type Credit = { holder: string; licence: Licence | null; url: string }

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
  ricVolume: string | null
  ricNumber: string | null
  date: string | null
  mint: (Link & { uncertain: boolean }) | null
  /** The source says the mint is uncertain but names none. */
  mintUnknown: boolean
  denominations: Link[]
  materials: string[]
  authorities: Person[]
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
    description: string | null
    segments: LegendSegment[] | null
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
  ric_volume: string | null
  ric_number: string | null
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
}

/*
 * Specimens worth showing first: photos that load, both sides photographed, then a single
 * combined photo, then the rest; within that, IIIF (sharp at any size) and measured coins first.
 */
const SPECIMEN_ORDER = `
  ORDER BY
    (SELECT count(*) FROM image WHERE specimen_id = s.id AND url LIKE ${REFUSING_HOST}) > 0,
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
      `SELECT t.*, m.name AS mint_name FROM coin_type t LEFT JOIN mint m ON m.id = t.mint_id WHERE t.id = ?`
    )
    .bind(id)
    .first<TypeRow>()
  if (!t) return { kind: "missing" }
  if (t.replaced_by_id) return { kind: "redirect", to: t.replaced_by_id }

  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args)
  const [people, orgs, denoms, mats, subjects, legends, parent, variants, specimens, imageRows, related] =
    await db.batch([
      q(
        `SELECT p.id, p.name, p.start_year, p.end_year, tp.role FROM type_person tp
         JOIN person p ON p.id = tp.person_id WHERE tp.type_id = ?
         ORDER BY tp.role = 'authority' DESC, p.name`,
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
      q(`SELECT side, legend, segments FROM legend WHERE type_id = ?`, id),
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
        `SELECT i.specimen_id, i.side, i.url, i.thumbnail_url, i.iiif_service FROM image i
         JOIN specimen_type st ON st.specimen_id = i.specimen_id WHERE st.type_id = ? ORDER BY i.id`,
        id
      ),
      // Same issuer and the same reverse legend (one issue), then the same issuer and denomination.
      q(
        `${CARD_SELECT}
         WHERE t.id != ?1 AND t.replaced_by_id IS NULL
           AND t.id IN (SELECT type_id FROM type_person WHERE role = 'authority'
                        AND person_id IN (SELECT person_id FROM type_person WHERE type_id = ?1 AND role = 'authority'))
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
    const rows = (imagesBySpecimen.get(specimenId) ?? []).filter((r) => !r.url.includes("gallica.bnf.fr")) // REFUSING_HOST
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
  const portraits = [
    ...new Map(
      peopleRows.filter((p) => p.role.startsWith("portrait") && !authorityIds.has(p.id)).map((p) => [p.id, toPerson(p)])
    ).values(),
  ]

  const legendRows = legends.results as { side: Side; legend: string; segments: string | null }[]
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
      description: side === "obverse" ? t.obv_description : t.rev_description,
      segments,
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
      ricVolume: t.ric_volume,
      ricNumber: t.ric_number,
      date: yearRange(t.start_year, t.end_year),
      mint: t.mint_id ? { id: t.mint_id, name: t.mint_name ?? t.mint_id, uncertain: !!t.mint_uncertain } : null,
      mintUnknown: !t.mint_id && !!t.mint_uncertain,
      denominations: denoms.results as Link[],
      materials: (mats.results as { name: string }[]).map((m) => m.name),
      authorities,
      portraits,
      organizations: orgs.results as Link[],
      subjects: subjects.results as (Link & { side: Side })[],
      parent: parentRow ? { id: parentRow.id, reference: parentRow.title ?? parentRow.id } : null,
      variants: variantCards,
      variantCredits,
      sides: [sideData("obverse"), sideData("reverse")].filter((s) => s.legend || s.description),
      hero: heroRow ? toSpecimen(heroRow, 900) : null,
      specimens: specimenRows.map((s) => toSpecimen(s, 900)),
      specimenCount: specimenRows.length,
      collectionCount: new Set(specimenRows.map((s) => s.holder)).size,
      related: relatedCards,
      relatedCredits,
    },
  }
}
