/*
 * A page's summary (lib/summary/index.ts): one row of page_summary, or, for a database loaded
 * without the table or a page it has no row for, the live queries.
 */
import { SUMMARIES, type Kind, type Sections } from "@/lib/summary"

export async function sections<K extends Kind>(db: D1Database, kind: K, id: string): Promise<Sections<K>> {
  try {
    const row = await db.prepare(`SELECT data FROM page_summary WHERE kind = ? AND id = ?`).bind(kind, id).first<{ data: string }>()
    if (row) return JSON.parse(row.data) as Sections<K>
  } catch (e) {
    if (!String(e).includes("no such table")) throw e
  }
  return SUMMARIES[kind].load(db, id) as Promise<Sections<K>>
}
