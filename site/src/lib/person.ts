/*
 * Data for the person page (/person/trajan): the person, every coin type connected to them (issued
 * by them or showing their portrait) with filters, and a strip of their portraits across the reign.
 * Filters come from the URL so every view is shareable.
 *
 * Portrait and issuer are separate filters, as the data models them: "coins of Plotina" are coins
 * with her portrait, struck by Trajan; Constantine issued thousands of coins for his sons.
 *
 * Coins struck in a ruler's name by others (role 'stated_authority' without 'authority': most
 * Alexanders were struck after his death, by his successors and by cities) are part of the ruler's
 * coinage but kept apart by the "Struck" filter.
 */
import { iiif, lead, secure, year, yearRange } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import { USABLE, type TypeCardData } from "@/lib/typeCards"
import { DENOMINATION, ISSUER, PERIOD, cards, coinage, parseCommon, periods, type Facet, type Filter, type Sort } from "@/lib/coinage"

export { PAGE_SIZE } from "@/lib/coinage"
export type { Facet, Sort }
const PORTRAITS = 6
/** Portrait filter value for types with no obverse portrait. */
export const NO_PORTRAIT = "none"
/** Struck filter values: the person's own coinage, or coins others struck in their name. */
export const OWN = "own"
export const IN_NAME = "name"

export type PersonQuery = {
  /** Obverse portrait: a person id, NO_PORTRAIT, or null for all. */
  portrait: string | null
  /** Issuing authority: a person id, or null for all. */
  issuer: string | null
  denomination: string | null
  /** A catalogue date range, "103-111". */
  period: string | null
  /** OWN, IN_NAME, or null for both. */
  struck: string | null
  sort: Sort
  limit: number
}

export type Person = {
  id: string
  name: string
  ruled: string | null
  lived: string | null
  lead: string | null
  article: { url: string; licence: string } | null
  mainMint: { id: string; name: string } | null
  /** The category most of their own coins are in, with its ancestors, broadest first. */
  categoryPath: { id: string; name: string }[]
  family: { relation: string; people: { id: string; name: string }[] }[]
  /** Their own portrait across the reign: up to six types, evenly spaced, earliest to latest. */
  portraits: { typeId: string; src: string; years: string | null; reference: string; denomination: string | null }[]
  /**
   * Years for the portrait heading: the reign when known, else the span of their own issues
   * (not coins merely struck in their name, nor posthumous ones dated after their reign or death).
   */
  portraitSpan: string | null
  portraitCredits: PhotoCreditItem[]
  /** Whether each filter can narrow the person's whole coinage (more than one option without filters). */
  available: { struck: boolean; portrait: boolean; issuer: boolean; denomination: boolean; period: boolean }
  struckFacet: Facet[]
  /** Types struck in the person's name by others, across the whole coinage. */
  inNameCount: number
  portraitFacet: Facet[]
  issuerFacet: Facet[]
  denominationFacet: Facet[]
  periodFacet: Facet[]
  total: number
  types: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

const RELATION_LABEL: Record<string, string> = { father: "Father", mother: "Mother", spouse: "Spouse", child: "Child" }

/* BASE is every live type connected to the person (?1). */
const BASE = `t.replaced_by_id IS NULL AND t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1)`
/* Struck in the person's name by someone else: they are named on it but are not its authority. */
const IN_NAME_SQL = `(t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role = 'stated_authority')
  AND t.id NOT IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role IN ('authority', 'issuer')))`
/* In the order of their parameters, ?2 to ?6. */
const FILTERS: Filter[] = [
  {
    name: "portrait",
    match: (v) => `(${v} = '${NO_PORTRAIT}' AND NOT EXISTS (SELECT 1 FROM type_person WHERE type_id = t.id AND role = 'portrait_obverse'))
              OR t.id IN (SELECT type_id FROM type_person WHERE role = 'portrait_obverse' AND person_id = ${v})`,
  },
  ISSUER,
  DENOMINATION,
  PERIOD,
  { name: "struck", match: (v) => `(${v} = '${IN_NAME}') = ${IN_NAME_SQL}` },
]

export function parseQuery(params: URLSearchParams): PersonQuery {
  const { slug, period, sort, limit } = parseCommon(params)
  return {
    struck: params.get("struck") === OWN || params.get("struck") === IN_NAME ? params.get("struck") : null,
    portrait: slug("portrait"),
    issuer: slug("issuer"),
    denomination: slug("denomination"),
    period,
    sort,
    limit,
  }
}

/** "356–323 BC"; "died 130 BC" or "born AD 53" when only one end is known. */
function lifespan(birth: number | null, death: number | null): string | null {
  if (birth != null && death != null) return yearRange(birth, death)
  if (death != null) return `died ${year(death)}`
  if (birth != null) return `born ${year(birth)}`
  return null
}

export async function getPerson(db: D1Database, id: string, query: PersonQuery): Promise<Person | null> {
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

  const c = coinage(db, id, BASE, FILTERS, [query.portrait, query.issuer, query.denomination, query.period, query.struck])
  const { one, grid, where } = c

  const [available, article, family, mainMint, ownSpan, categories, struckFacet, portraitFacet, noPortrait, issuerFacet, denoms, periodRows, total, types, portraits] =
    await db.batch([
      // Option counts over the unfiltered coinage, to decide which filters the page offers.
      one(`SELECT
             (SELECT count(*) FROM coin_type t WHERE ${BASE} AND ${IN_NAME_SQL}) AS in_name,
             (SELECT count(*) FROM coin_type t WHERE ${BASE} AND NOT ${IN_NAME_SQL}) AS own,
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
      // Fallback for the portrait heading when the reign is unknown: their own issues, in their lifetime/reign.
      one(`SELECT min(t.start_year) AS s, max(coalesce(t.end_year, t.start_year)) AS e FROM coin_type t
           WHERE t.replaced_by_id IS NULL AND t.start_year IS NOT NULL
             AND t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role != 'stated_authority')
             AND t.start_year <= coalesce((SELECT coalesce(end_year, death_year) FROM person WHERE id = ?1), t.start_year)`),
      // Their coins' commonest primary category (their own issues first), then its ancestors.
      one(`WITH RECURSIVE home AS (
             SELECT tc.category_id AS id FROM type_category tc JOIN type_person tp ON tp.type_id = tc.type_id
             WHERE tp.person_id = ?1 AND tc.is_primary = 1
             GROUP BY tc.category_id
             ORDER BY count(DISTINCT CASE WHEN tp.role IN ('authority', 'issuer') THEN tc.type_id END) DESC,
               count(DISTINCT tc.type_id) DESC
             LIMIT 1
           ),
           path(id, name, parent_id, depth) AS (
             SELECT c.id, c.name, c.parent_id, 0 FROM category c JOIN home ON home.id = c.id
             UNION ALL SELECT c.id, c.name, c.parent_id, p.depth + 1 FROM category c JOIN path p ON c.id = p.parent_id
           )
           SELECT id, name FROM path ORDER BY depth DESC`),
      grid(`SELECT ${IN_NAME_SQL} AS in_name, count(*) AS count FROM coin_type t WHERE ${where("struck")} GROUP BY 1`),
      // Whose portrait is on the obverse: the person first, then others by count.
      grid(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
            FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role = 'portrait_obverse'
            JOIN person p ON p.id = tp.person_id
            WHERE ${where("portrait")} GROUP BY p.id ORDER BY p.id = ?1 DESC, count DESC, p.name`),
      grid(`SELECT count(*) AS count FROM coin_type t WHERE ${where("portrait")}
            AND NOT EXISTS (SELECT 1 FROM type_person WHERE type_id = t.id AND role = 'portrait_obverse')`),
      c.issuerFacet(true),
      c.denominationFacet(),
      c.periodFacet(),
      c.total(),
      c.types(query.sort, query.limit),
      // Their own portrait, one per distinct start year, earliest to latest; sampled below.
      one(`SELECT t.id, t.title, t.start_year, t.end_year,
             (SELECT d.name FROM type_denomination td JOIN denomination d ON d.id = td.denomination_id
              WHERE td.type_id = t.id LIMIT 1) AS denomination,
             (SELECT i.url FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
              WHERE st.type_id = t.id AND i.side = 'obverse' AND ${USABLE("i")}
              ORDER BY i.iiif_service IS NULL LIMIT 1) AS url,
             (SELECT i.iiif_service FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
              WHERE st.type_id = t.id AND i.side = 'obverse' AND ${USABLE("i")}
              ORDER BY i.iiif_service IS NULL LIMIT 1) AS iiif,
             (SELECT i.id FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
              WHERE st.type_id = t.id AND i.side = 'obverse' AND ${USABLE("i")}
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
  const byYear = new Map<number, Person["portraits"][number]>()
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

  const own = ownSpan.results[0] as { s: number | null; e: number | null } | undefined
  const portraitSpan = yearRange(person.start_year, person.end_year) ?? yearRange(own?.s ?? null, own?.e ?? null)
  const shownImages = picks.map((p) => imageIds.get(p.typeId)).filter((id): id is number => id != null)
  const [portraitCredits, grid_] = await Promise.all([getPhotoCredits(db, shownImages), cards(db, types)])

  const none = (noPortrait.results[0] as { count: number }).count
  const opts = available.results[0] as Record<"in_name" | "own" | "portrait" | "issuer" | "denomination" | "period", number>
  const struckCounts = new Map((struckFacet.results as { in_name: number; count: number }[]).map((r) => [!!r.in_name, r.count]))

  return {
    id: person.id,
    name: person.name,
    ruled: yearRange(person.start_year, person.end_year),
    lived: lifespan(person.birth_year, person.death_year),
    lead: lead(art?.extract ?? person.definition),
    article: art ? { url: art.url, licence: art.licence } : null,
    mainMint: (mainMint.results[0] as { id: string; name: string } | undefined) ?? null,
    categoryPath: categories.results as { id: string; name: string }[],
    family: familyGroups,
    portraits: picks,
    portraitSpan,
    portraitCredits,
    available: {
      struck: opts.own > 0 && opts.in_name > 0,
      portrait: opts.portrait > 1,
      issuer: opts.issuer > 1,
      denomination: opts.denomination > 1,
      period: opts.period > 1,
    },
    struckFacet: [
      { value: OWN, label: "Own issues", count: struckCounts.get(false) ?? 0 },
      { value: IN_NAME, label: "Struck in their name", count: struckCounts.get(true) ?? 0 },
    ],
    inNameCount: opts.in_name,
    portraitFacet: [
      ...(portraitFacet.results as Facet[]),
      ...(none ? [{ value: NO_PORTRAIT, label: "No portrait", count: none }] : []),
    ],
    issuerFacet: issuerFacet.results as Facet[],
    denominationFacet: denoms.results as Facet[],
    periodFacet: periods(periodRows),
    total: (total.results[0] as { n: number }).n,
    types: grid_.types,
    typeCredits: grid_.typeCredits,
  }
}
