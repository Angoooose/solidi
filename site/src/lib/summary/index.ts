/*
 * Page summaries: the sections of the mint, person, denomination and subject pages that don't
 * depend on the page's filters. They only change when the database is rebuilt, so
 * scripts/summaries.ts computes one per page into the page_summary table before the database is
 * loaded, and a page reads it as a single row (store.ts) instead of running these queries, which
 * scan tens of thousands of rows, on every filtered view.
 *
 * Each section is the rows its query returns, so a page renders the same from a stored summary
 * as from the live queries.
 */
import { denominationSections } from "@/lib/summary/denomination"
import { mintSections } from "@/lib/summary/mint"
import { personSections } from "@/lib/summary/person"
import { subjectSections } from "@/lib/summary/subject"

export const SUMMARIES = {
  mint: { ids: `SELECT id FROM mint WHERE parent_id IS NULL`, load: mintSections },
  person: { ids: `SELECT id FROM person`, load: personSections },
  denomination: { ids: `SELECT denomination_id AS id FROM denomination_stat`, load: denominationSections },
  subject: { ids: `SELECT subject_id AS id FROM subject_stat`, load: subjectSections },
}

export type Kind = keyof typeof SUMMARIES
export type Sections<K extends Kind> = Awaited<ReturnType<(typeof SUMMARIES)[K]["load"]>>

export const SCHEMA = `CREATE TABLE page_summary (
  kind TEXT NOT NULL,  -- 'mint' | 'person' | 'denomination' | 'subject'
  id   TEXT NOT NULL,  -- the page's id
  data TEXT NOT NULL,  -- JSON: the page's sections (lib/summary/)
  PRIMARY KEY (kind, id)
)`
