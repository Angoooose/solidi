/*
 * The subject page's sections that don't depend on its filters (lib/subject.ts): its article,
 * where it was struck, who issued it, its denominations, mints and the legends naming it.
 */
import type { Facet } from "@/lib/coinage"

const NOT_PEOPLE = `('anonymous')`
/* Every live type showing the subject (?1); the coinage grid takes the same set from the facet
 * index (subjectBase). */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.id IN (SELECT type_id FROM type_subject WHERE subject_id = ?1)`

export type SubjectSections = {
  article: { extract: string; url: string; licence: string }[]
  perCollection: { id: string; n: number; start: number | null; end: number | null; bins: string | null }[]
  people: Facet[]
  denominations: Facet[]
  mints: Facet[]
  legends: Facet[]
}

export async function subjectSections(db: D1Database, id: string): Promise<SubjectSections> {
  const one = (sql: string) => db.prepare(sql).bind(id)
  const [article, perCollection, people, denominations, mints, legends] = (
    await db.batch([
      one(`SELECT extract, url, licence FROM article WHERE entity_type = 'subject' AND entity_id = ?1
           ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
      one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", bins FROM category_subject WHERE subject_id = ?1`),
      one(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer') JOIN person p ON p.id = tp.person_id
           WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE} GROUP BY p.id ORDER BY count DESC, p.name`),
      one(`SELECT d.id AS value, d.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_denomination td ON td.type_id = t.id JOIN denomination d ON d.id = td.denomination_id
           WHERE ${BASE} GROUP BY d.id ORDER BY count DESC, d.name`),
      one(`SELECT coalesce(pm.id, m.id) AS value, coalesce(pm.name, m.name) AS label, count(*) AS count
           FROM coin_type t JOIN mint m ON m.id = t.mint_id LEFT JOIN mint pm ON pm.id = m.parent_id
           WHERE ${BASE} GROUP BY value ORDER BY count DESC, label`),
      one(`SELECT legend AS value, legend AS label, n AS count FROM subject_legend WHERE subject_id = ?1 ORDER BY n DESC, legend`),
    ])
  ).map((r) => r.results)
  return { article, perCollection, people, denominations, mints, legends } as SubjectSections
}
