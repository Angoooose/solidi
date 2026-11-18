/*
 * Data for the ruler page (/ruler/trajan): the person, every coin type connected to them (issued
 * by them or showing their portrait) with filters, and a strip of their portraits across the reign.
 * Filters come from the URL so every view is shareable.
 *
 * Portrait and issuer are separate filters, as the data models them: "coins of Plotina" are coins
 * with her portrait, struck by Trajan; Constantine issued thousands of coins for his sons.
 */
import { iiif, secure, yearRange } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import { CARD_SELECT, REFUSING_HOST, card, type CardRow, type TypeCardData } from "@/lib/typeCards"

export const PAGE_SIZE = 30
const PORTRAITS = 6
/** Portrait filter value for types with no obverse portrait. */
export const NO_PORTRAIT = "none"

export type Sort = "earliest" | "latest" | "reference"

export type RulerQuery = {
  /** Obverse portrait: a person id, NO_PORTRAIT, or null for all. */
  portrait: string | null
  /** Issuing authority: a person id, or null for all. */
  issuer: string | null
  denomination: string | null
  /** A catalogue date range, "103-111". */
  period: string | null
  sort: Sort
  limit: number
}

export type Facet = { value: string; label: string; count: number }

export type Ruler = {
  id: string
  name: string
  ruled: string | null
  lived: string | null
  lead: string | null
  article: { url: string; licence: string } | null
  mainMint: { id: string; name: string } | null
  family: { relation: string; people: { id: string; name: string }[] }[]
  /** Their own portrait across the reign: up to six types, evenly spaced, earliest to latest. */
  portraits: { typeId: string; src: string; years: string | null; reference: string; denomination: string | null }[]
  portraitCredits: PhotoCreditItem[]
  /** Whether each filter can narrow the person's whole coinage (more than one option without filters). */
  available: { portrait: boolean; issuer: boolean; denomination: boolean; period: boolean }
  portraitFacet: Facet[]
  issuerFacet: Facet[]
  denominationFacet: Facet[]
  periodFacet: Facet[]
  total: number
  types: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

const ORDER: Record<Sort, string> = {
  earliest: `t.start_year IS NULL, t.start_year, t.end_year, t.ric_volume, CAST(t.ric_number AS INTEGER), t.id`,
  latest: `t.start_year IS NULL, t.start_year DESC, t.end_year DESC, t.ric_volume, CAST(t.ric_number AS INTEGER), t.id`,
  reference: `t.ric_volume, CAST(t.ric_number AS INTEGER), t.ric_number, t.id`,
}

const RELATION_LABEL: Record<string, string> = { father: "Father", mother: "Mother", spouse: "Spouse", child: "Child" }

/*
 * Parameters: ?1 person, ?2 portrait, ?3 issuer, ?4 denomination, ?5 period ('' = any).
 * BASE is every live type connected to the person. Each filter matches everything when empty.
 */
const BASE = `t.replaced_by_id IS NULL AND t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1)`
const FILTER = {
  portrait: `(?2 = '' OR (?2 = '${NO_PORTRAIT}' AND NOT EXISTS (SELECT 1 FROM type_person WHERE type_id = t.id AND role = 'portrait_obverse'))
              OR t.id IN (SELECT type_id FROM type_person WHERE role = 'portrait_obverse' AND person_id = ?2))`,
  issuer: `(?3 = '' OR t.id IN (SELECT type_id FROM type_person WHERE role IN ('authority', 'issuer') AND person_id = ?3))`,
  denomination: `(?4 = '' OR t.id IN (SELECT type_id FROM type_denomination WHERE denomination_id = ?4))`,
  period: `(?5 = '' OR (coalesce(t.start_year, '') || '-' || coalesce(t.end_year, '')) = ?5)`,
}
const PARAM = { portrait: "?2", issuer: "?3", denomination: "?4", period: "?5" }
type FilterName = keyof typeof FILTER

/*
 * WHERE for the grid, or for one facet: a facet ignores its own filter so each option's count is
 * what you'd get by choosing it. D1 requires every bound value to be used, hence `?n IS NOT NULL`.
 */
function where(except?: FilterName): string {
  const parts = (Object.keys(FILTER) as FilterName[]).map((f) => (f === except ? `${PARAM[f]} IS NOT NULL` : FILTER[f]))
  return [BASE, ...parts].join(" AND ")
}

const SLUG = /^[a-z0-9][a-z0-9_.-]*$/

export function parseQuery(params: URLSearchParams): RulerQuery {
  const slug = (k: string) => (SLUG.test(params.get(k) ?? "") ? params.get(k) : null)
  const sort = params.get("sort") as Sort
  const limit = Number(params.get("limit"))
  return {
    portrait: slug("portrait"),
    issuer: slug("issuer"),
    denomination: slug("denomination"),
    period: /^-?\d+--?\d+$/.test(params.get("date") ?? "") ? params.get("date") : null,
    sort: sort in ORDER ? sort : "earliest",
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 600) : PAGE_SIZE,
  }
}

/** First sentences of an extract, up to about `max` characters, ending on a full stop. */
function lead(text: string | null, max = 320): string | null {
  if (!text) return null
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text]
  let out = ""
  for (const s of sentences) {
    if (out && out.length + s.length > max) break
    out += s
  }
  return out.trim()
}

export async function getRuler(db: D1Database, id: string, query: RulerQuery): Promise<Ruler | null> {
  const person = await db
    .prepare(`SELECT id, name, definition, start_year, end_year, birth_year, death_year FROM person WHERE id = ?`)
    .bind(id)
    .first<{
      id: string
      name: string
      definition: string | null
      start_year: number | null
      end_year: number | null
      birth_year: number | null
      death_year: number | null
    }>()
  if (!person) return null

  /** Statements about the person alone bind ?1; statements about the filtered grid bind ?1–?5. */
  const one = (sql: string) => db.prepare(sql).bind(id)
  const grid = (sql: string) =>
    db.prepare(sql).bind(id, query.portrait ?? "", query.issuer ?? "", query.denomination ?? "", query.period ?? "")

  const [available, article, family, mainMint, portraitFacet, noPortrait, issuerFacet, denoms, periods, total, types, portraits] =
    await db.batch([
      // Option counts over the unfiltered coinage, to decide which filters the page offers.
      one(`SELECT
             (SELECT count(DISTINCT tp.person_id) FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role = 'portrait_obverse' WHERE ${BASE})
               + (SELECT count(*) > 0 FROM coin_type t WHERE ${BASE}
                  AND NOT EXISTS (SELECT 1 FROM type_person WHERE type_id = t.id AND role = 'portrait_obverse')) AS portrait,
             (SELECT count(DISTINCT tp.person_id) FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer') WHERE ${BASE}) AS issuer,
             (SELECT count(DISTINCT td.denomination_id) FROM coin_type t JOIN type_denomination td ON td.type_id = t.id WHERE ${BASE}) AS denomination,
             (SELECT count(DISTINCT t.start_year || '-' || coalesce(t.end_year, '')) FROM coin_type t WHERE ${BASE} AND t.start_year IS NOT NULL) AS period`),
      one(`SELECT extract, url, licence FROM article WHERE entity_type = 'person' AND entity_id = ?1
           ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
      one(`SELECT r.relation, p.id, p.name FROM person_relation r JOIN person p ON p.id = r.related_person_id
           WHERE r.person_id = ?1 ORDER BY p.birth_year IS NULL, p.birth_year, p.name`),
      one(`SELECT m.id, m.name FROM coin_type t JOIN mint m ON m.id = t.mint_id
           WHERE t.replaced_by_id IS NULL
             AND t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role IN ('authority', 'issuer'))
           GROUP BY m.id ORDER BY count(*) DESC LIMIT 1`),
      // Whose portrait is on the obverse: the person first, then others by count.
      grid(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
            FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role = 'portrait_obverse'
            JOIN person p ON p.id = tp.person_id
            WHERE ${where("portrait")} GROUP BY p.id ORDER BY p.id = ?1 DESC, count DESC, p.name`),
      grid(`SELECT count(*) AS count FROM coin_type t WHERE ${where("portrait")}
            AND NOT EXISTS (SELECT 1 FROM type_person WHERE type_id = t.id AND role = 'portrait_obverse')`),
      grid(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
            FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer')
            JOIN person p ON p.id = tp.person_id
            WHERE ${where("issuer")} GROUP BY p.id ORDER BY p.id = ?1 DESC, count DESC, p.name`),
      grid(`SELECT d.id AS value, d.name AS label, count(*) AS count
            FROM coin_type t JOIN type_denomination td ON td.type_id = t.id JOIN denomination d ON d.id = td.denomination_id
            WHERE ${where("denomination")} GROUP BY d.id ORDER BY count DESC, d.name`),
      grid(`SELECT coalesce(t.start_year, '') || '-' || coalesce(t.end_year, '') AS value,
              t.start_year AS s, t.end_year AS e, count(*) AS count
            FROM coin_type t WHERE ${where("period")} AND t.start_year IS NOT NULL
            GROUP BY value ORDER BY t.start_year, t.end_year`),
      grid(`SELECT count(*) AS n FROM coin_type t WHERE ${where()}`),
      grid(`${CARD_SELECT} WHERE ${where()} ORDER BY ${ORDER[query.sort]} LIMIT ${query.limit}`),
      // Their own portrait, one per distinct start year, earliest to latest; sampled below.
      one(`SELECT t.id, t.title, t.start_year, t.end_year,
             (SELECT d.name FROM type_denomination td JOIN denomination d ON d.id = td.denomination_id
              WHERE td.type_id = t.id LIMIT 1) AS denomination,
             (SELECT i.url FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
              WHERE st.type_id = t.id AND i.side = 'obverse' AND i.url NOT LIKE ${REFUSING_HOST}
              ORDER BY i.iiif_service IS NULL LIMIT 1) AS url,
             (SELECT i.iiif_service FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
              WHERE st.type_id = t.id AND i.side = 'obverse' AND i.url NOT LIKE ${REFUSING_HOST}
              ORDER BY i.iiif_service IS NULL LIMIT 1) AS iiif,
             (SELECT i.id FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
              WHERE st.type_id = t.id AND i.side = 'obverse' AND i.url NOT LIKE ${REFUSING_HOST}
              ORDER BY i.iiif_service IS NULL LIMIT 1) AS image_id
           FROM coin_type t
           WHERE t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role = 'portrait_obverse')
             AND t.replaced_by_id IS NULL AND t.start_year IS NOT NULL
           ORDER BY t.start_year, t.end_year, t.id`),
    ])

  const art = article.results[0] as { extract: string; url: string; licence: string } | undefined

  const familyRows = family.results as { relation: string; id: string; name: string }[]
  const familyGroups = Object.entries(RELATION_LABEL)
    .map(([rel, label]) => {
      const people = familyRows.filter((r) => r.relation === rel).map(({ id, name }) => ({ id, name }))
      const plural = people.length > 1 ? (rel === "child" ? "Children" : label + "s") : label
      return { relation: plural, people }
    })
    .filter((g) => g.people.length)

  // One portrait per start year that has a photo, then evenly spaced picks across the reign.
  const byYear = new Map<number, Ruler["portraits"][number]>()
  const imageIds = new Map<string, number>()
  for (const r of portraits.results as { id: string; title: string | null; denomination: string | null; start_year: number; end_year: number | null; url: string | null; iiif: string | null; image_id: number | null }[]) {
    if (r.image_id != null) imageIds.set(r.id, r.image_id)
    const src = iiif(r.iiif, 400) ?? secure(r.url)
    if (src && !byYear.has(r.start_year))
      byYear.set(r.start_year, {
        typeId: r.id,
        src,
        years: yearRange(r.start_year, r.end_year),
        reference: r.title ?? r.id,
        denomination: r.denomination,
      })
  }
  const all = [...byYear.values()]
  const picks =
    all.length <= PORTRAITS ? all : Array.from({ length: PORTRAITS }, (_, i) => all[Math.round((i * (all.length - 1)) / (PORTRAITS - 1))])

  const shownImages = picks.map((p) => imageIds.get(p.typeId)).filter((id): id is number => id != null)
  const cards = (types.results as CardRow[]).map(card)
  const [portraitCredits, typeCredits] = await Promise.all([
    getPhotoCredits(db, shownImages),
    getPhotoCredits(db, cards.map((c) => c.imageId).filter((i): i is number => i != null)),
  ])

  const none = (noPortrait.results[0] as { count: number }).count
  const opts = available.results[0] as Record<"portrait" | "issuer" | "denomination" | "period", number>

  return {
    id: person.id,
    name: person.name,
    ruled: yearRange(person.start_year, person.end_year),
    lived: yearRange(person.birth_year, person.death_year),
    lead: lead(art?.extract ?? person.definition),
    article: art ? { url: art.url, licence: art.licence } : null,
    mainMint: (mainMint.results[0] as { id: string; name: string } | undefined) ?? null,
    family: familyGroups,
    portraits: picks,
    portraitCredits,
    available: {
      portrait: opts.portrait > 1,
      issuer: opts.issuer > 1,
      denomination: opts.denomination > 1,
      period: opts.period > 1,
    },
    portraitFacet: [
      ...(portraitFacet.results as Facet[]),
      ...(none ? [{ value: NO_PORTRAIT, label: "No portrait", count: none }] : []),
    ],
    issuerFacet: issuerFacet.results as Facet[],
    denominationFacet: denoms.results as Facet[],
    periodFacet: (periods.results as { value: string; s: number; e: number | null; count: number }[]).map((p) => ({
      value: p.value,
      label: yearRange(p.s, p.e) ?? p.value,
      count: p.count,
    })),
    total: (total.results[0] as { n: number }).n,
    types: cards,
    typeCredits,
  }
}
