/*
 * The mint page's sections that don't depend on its filters (lib/mint.ts): its article, output per
 * collection, specimens, the people who struck there and its denominations, metals and subjects.
 */
import type { Facet } from "@/lib/coinage"

const NOT_PEOPLE = `('anonymous')`
/* Every live type struck at the mint (?1) or one of its workshops; the coinage grid takes the same
 * set from the facet index (mintBase). */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.mint_id IN (SELECT id FROM mint WHERE id = ?1 OR parent_id = ?1)`

export type MintSections = {
  article: { extract: string; url: string; licence: string }[]
  perCollection: { id: string; n: number; start: number | null; end: number | null; bins: string | null }[]
  stats: { specimens: number; holders: number }[]
  people: { id: string; name: string; n: number; os: number | null; oe: number | null; cs: number | null; ce: number | null }[]
  denominations: Facet[]
  materials: Facet[]
  subjects: Facet[]
}

export async function mintSections(db: D1Database, id: string): Promise<MintSections> {
  const one = (sql: string) => db.prepare(sql).bind(id)
  const facet = (join: string, table: string) =>
    one(`SELECT x.id AS value, x.name AS label, count(DISTINCT t.id) AS count
         FROM coin_type t JOIN ${join} j ON j.type_id = t.id JOIN ${table} x ON x.id = j.${table}_id
         WHERE ${BASE} GROUP BY x.id ORDER BY count DESC, x.name`)
  const [article, perCollection, stats, people, denominations, materials, subjects] = (
    await db.batch([
      one(`SELECT extract, url, licence FROM article WHERE entity_type = 'mint' AND entity_id = ?1
           ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
      one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", bins FROM category_mint WHERE mint_id = ?1`),
      one(`SELECT count(DISTINCT st.specimen_id) AS specimens, count(DISTINCT s.institution_id) AS holders
           FROM coin_type t JOIN specimen_type st ON st.type_id = t.id JOIN specimen s ON s.id = st.specimen_id WHERE ${BASE}`),
      one(`SELECT p.id, p.name, p.start_year AS os, coalesce(p.end_year, p.start_year) AS oe, count(DISTINCT t.id) AS n,
             min(t.start_year) AS cs, max(coalesce(t.end_year, t.start_year)) AS ce
           FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer')
           JOIN person p ON p.id = tp.person_id
           WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE}
           GROUP BY p.id
           ORDER BY coalesce(os, cs) IS NULL, coalesce(os, cs), coalesce(oe, ce), n DESC, p.name`),
      facet("type_denomination", "denomination"),
      facet("type_material", "material"),
      facet("type_subject", "subject"),
    ])
  ).map((r) => r.results)
  return { article, perCollection, stats, people, denominations, materials, subjects } as MintSections
}
