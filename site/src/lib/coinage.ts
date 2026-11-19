/*
 * A filtered, sorted grid of coin types with a facet per filter: the "Coinage" section of the
 * person and mint pages. Each page supplies its BASE (every type it covers, bound to ?1) and its
 * filters; this module numbers their parameters, builds the WHERE for the grid and each facet,
 * and runs the shared statements (the grid, its total, the common facets).
 *
 * Filters come from the URL so every view is shareable. A facet ignores its own filter, so each
 * option's count is what you'd get by choosing it.
 */
import { yearRange } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import { CARD_SELECT, card, type CardRow, type TypeCardData } from "@/lib/typeCards"

export const PAGE_SIZE = 30

export type Sort = "earliest" | "latest" | "reference"
export type Facet = { value: string; label: string; count: number }

/* r is the type's primary catalogue reference, joined by the grid query; its sort_key orders volumes and numbers naturally. */
const ORDER: Record<Sort, string> = {
  earliest: `t.start_year IS NULL, t.start_year, t.end_year, r.sort_key, t.id`,
  latest: `t.start_year IS NULL, t.start_year DESC, t.end_year DESC, r.sort_key, t.id`,
  reference: `r.sort_key, t.id`,
}

/**
 * One filter: `match(v)` is the condition on `coin_type t` for the value bound to parameter `v`
 * (a "?n"). It applies only when a value is chosen.
 */
export type Filter = { name: string; match: (v: string) => string }

/* Filters most coinages share. */
export const DENOMINATION: Filter = { name: "denomination", match: (v) => `t.id IN (SELECT type_id FROM type_denomination WHERE denomination_id = ${v})` }
export const PERIOD: Filter = { name: "period", match: (v) => `(coalesce(t.start_year, '') || '-' || coalesce(t.end_year, '')) = ${v}` }
export const ISSUER: Filter = { name: "issuer", match: (v) => `t.id IN (SELECT type_id FROM type_person WHERE role IN ('authority', 'issuer') AND person_id = ${v})` }
export const MATERIAL: Filter = { name: "material", match: (v) => `t.id IN (SELECT type_id FROM type_material WHERE material_id = ${v})` }

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/** The URL parameters every coinage reads: sort, limit, and a slug or date range reader for filters. */
export function parseCommon(params: URLSearchParams) {
  const sort = params.get("sort") as Sort
  const limit = Number(params.get("limit"))
  return {
    slug: (k: string) => (SLUG.test(params.get(k) ?? "") ? params.get(k) : null),
    period: /^-?\d+--?\d+$/.test(params.get("date") ?? "") ? params.get("date") : null,
    sort: sort in ORDER ? sort : ("earliest" as Sort),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 600) : PAGE_SIZE,
  }
}

/**
 * The statements for one coinage: `base` is every type it covers (using ?1 for the page's id),
 * `filters` are numbered ?2, ?3… in order and bound to `values`.
 */
export function coinage(db: D1Database, id: string, base: string, filters: Filter[], values: (string | null)[]) {
  const param = (name: string) => `?${filters.findIndex((f) => f.name === name) + 2}`
  /*
   * WHERE for the grid, or for one facet (`except` drops its own filter). D1 requires every bound
   * value to be used, hence `?n IS NOT NULL` in its place.
   */
  const where = (except?: string) =>
    [base, ...filters.map((f) => (f.name === except ? `${param(f.name)} IS NOT NULL` : `(${param(f.name)} = '' OR ${f.match(param(f.name))})`))].join(" AND ")
  /** Statements about the page's id alone bind ?1; statements about the filtered grid bind every value. */
  const one = (sql: string) => db.prepare(sql).bind(id)
  const grid = (sql: string) => db.prepare(sql).bind(id, ...values.map((v) => v ?? ""))
  return {
    where,
    one,
    grid,
    /** Who issued them; `selfFirst` puts the page's own person first (?1). */
    issuerFacet: (selfFirst = false) =>
      grid(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
            FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer')
            JOIN person p ON p.id = tp.person_id
            WHERE ${where("issuer")} GROUP BY p.id ORDER BY ${selfFirst ? "p.id = ?1 DESC, " : ""}count DESC, p.name`),
    denominationFacet: () =>
      grid(`SELECT d.id AS value, d.name AS label, count(*) AS count
            FROM coin_type t JOIN type_denomination td ON td.type_id = t.id JOIN denomination d ON d.id = td.denomination_id
            WHERE ${where("denomination")} GROUP BY d.id ORDER BY count DESC, d.name`),
    materialFacet: () =>
      grid(`SELECT x.id AS value, x.name AS label, count(*) AS count
            FROM coin_type t JOIN type_material tm ON tm.type_id = t.id JOIN material x ON x.id = tm.material_id
            WHERE ${where("material")} GROUP BY x.id ORDER BY count DESC, x.name`),
    periodFacet: () =>
      grid(`SELECT coalesce(t.start_year, '') || '-' || coalesce(t.end_year, '') AS value,
              t.start_year AS s, t.end_year AS e, count(*) AS count
            FROM coin_type t WHERE ${where("period")} AND t.start_year IS NOT NULL
            GROUP BY value ORDER BY t.start_year, t.end_year`),
    total: () => grid(`SELECT count(*) AS n FROM coin_type t WHERE ${where()}`),
    types: (sort: Sort, limit: number) =>
      grid(`${CARD_SELECT}
            LEFT JOIN type_reference r ON r.type_id = t.id AND r.is_primary = 1
            WHERE ${where()} ORDER BY ${ORDER[sort]} LIMIT ${limit}`),
  }
}

/** Period options labelled by their dates: "AD 103–111". */
export function periods(result: D1Result): Facet[] {
  return (result.results as { value: string; s: number; e: number | null; count: number }[]).map((p) => ({
    value: p.value,
    label: yearRange(p.s, p.e) ?? p.value,
    count: p.count,
  }))
}

/** The grid's cards and the credits for their photos. */
export async function cards(db: D1Database, result: D1Result): Promise<{ types: TypeCardData[]; typeCredits: PhotoCreditItem[] }> {
  const types = (result.results as CardRow[]).map(card)
  const typeCredits = await getPhotoCredits(db, types.map((c) => c.imageId).filter((i): i is number => i != null))
  return { types, typeCredits }
}
