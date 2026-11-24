/*
 * The person page's sections that don't depend on its filters (lib/person.ts): which filters it
 * offers, their article and family, main mint, home collection and the portraits across the reign.
 */
import { iiif, secure } from "@/lib/format"
import { USABLE } from "@/lib/typeCards"

/* Every live type connected to the person (?1); the coinage grid takes the same set from the
 * facet index (personBase). */
const BASE = `t.replaced_by_id IS NULL AND t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1)`
/* Struck in the person's name by someone else: they are named on it but are not its authority. */
const IN_NAME_SQL = `(t.id IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role = 'stated_authority')
  AND t.id NOT IN (SELECT type_id FROM type_person WHERE person_id = ?1 AND role IN ('authority', 'issuer')))`

export type PersonSections = {
  available: Record<"in_name" | "own" | "portrait" | "issuer" | "denomination" | "period", number>[]
  article: { extract: string; url: string; licence: string }[]
  family: { relation: string; id: string; name: string }[]
  mainMint: { id: string; name: string }[]
  ownSpan: { s: number | null; e: number | null }[]
  categories: { id: string; name: string }[]
  portraits: { id: string; title: string | null; denomination: string | null; start_year: number; end_year: number | null; url: string | null; iiif: string | null; image_id: number | null }[]
}

export async function personSections(db: D1Database, id: string): Promise<PersonSections> {
  const one = (sql: string) => db.prepare(sql).bind(id)
  const [available, article, family, mainMint, ownSpan, categories, portraits] = (
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
      // Their own portraits, earliest to latest.
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
  ).map((r) => r.results)
  // The page shows the first photographed portrait of each start year (sampled down to a few), so
  // keep only those: a long reign has thousands of portrait types.
  const years = new Set<number>()
  const shown = (portraits as PersonSections["portraits"]).filter((r) => {
    if (years.has(r.start_year) || !(iiif(r.iiif, 400) ?? secure(r.url))) return false
    years.add(r.start_year)
    return true
  })
  return { available, article, family, mainMint, ownSpan, categories, portraits: shown } as PersonSections
}
