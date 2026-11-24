/*
 * The denomination page's sections that don't depend on its filters (lib/denomination.ts): its
 * article, where it was struck, how it compares in size, who issued it, its mints and subjects.
 */
import { IMAGE_COLS } from "@/lib/categories"
import type { Facet } from "@/lib/coinage"

const NOT_PEOPLE = `('anonymous')`
/* Every live type of the denomination (?1); the coinage grid takes the same set from the facet
 * index (denominationBase). */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.id IN (SELECT type_id FROM type_denomination WHERE denomination_id = ?1)`

export type DenominationSections = {
  article: { extract: string; url: string; licence: string }[]
  perCollection: { id: string; n: number; start: number | null; end: number | null; weight: number | null; bins: string | null }[]
  sizes: { cat: string; tab: number; ws: number | null; we: number | null; other: string; name: string; diameter: number; url: string | null; thumb: string | null; iiif: string | null }[]
  people: Facet[]
  mints: Facet[]
  subjects: Facet[]
}

export async function denominationSections(db: D1Database, id: string): Promise<DenominationSections> {
  const one = (sql: string) => db.prepare(sql).bind(id)
  const [article, perCollection, sizes, people, mints, subjects] = (
    await db.batch([
      one(`SELECT extract, url, licence FROM article WHERE entity_type = 'denomination' AND entity_id = ?1
           ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
      one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", weight, bins FROM category_denomination WHERE denomination_id = ?1`),
      one(`SELECT z.category_id AS cat, z.tab, z.window_start AS ws, z.window_end AS we, z.other_id AS other, o.name, z.diameter, ${IMAGE_COLS}
           FROM denomination_size z JOIN denomination o ON o.id = z.other_id
           LEFT JOIN category_denomination cd ON cd.category_id = z.category_id AND cd.denomination_id = z.other_id
           LEFT JOIN image i ON i.id = cd.image_id
           WHERE z.denomination_id = ?1 ORDER BY z.tab, z.diameter DESC`),
      one(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer') JOIN person p ON p.id = tp.person_id
           WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE} GROUP BY p.id ORDER BY count DESC, p.name`),
      one(`SELECT coalesce(pm.id, m.id) AS value, coalesce(pm.name, m.name) AS label, count(*) AS count
           FROM coin_type t JOIN mint m ON m.id = t.mint_id LEFT JOIN mint pm ON pm.id = m.parent_id
           WHERE ${BASE} GROUP BY value ORDER BY count DESC, label`),
      one(`SELECT x.id AS value, x.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_subject j ON j.type_id = t.id JOIN subject x ON x.id = j.subject_id
           WHERE ${BASE} GROUP BY x.id ORDER BY count DESC, x.name`),
    ])
  ).map((r) => r.results)
  return { article, perCollection, sizes, people, mints, subjects } as DenominationSections
}
