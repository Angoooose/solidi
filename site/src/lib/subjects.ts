/*
 * Data for the subjects list (/subjects). Read from subject_stat and
 * category_subject (pipeline/summaries.py): a row per subject, or per subject in a collection,
 * with its count, dates, 25-year histogram and a photo. A Greek god and its Roman counterpart
 * (data/subjects.yaml) share one row: "Zeus · Jupiter".
 */
import { tree, getCategories, photo, IMAGE_COLS, type Category, type Photo, type Tree } from "@/lib/categories"
import type { Bin } from "@/components/charts"

export const SUBJECT_BIN = 25

export const SUBJECT_GROUPS = [
  { id: "gods", name: "Gods and personifications" },
  { id: "places", name: "Places" },
] as const
/** "unlisted": not a subject ("Uncertain value"); its page exists but no list shows it. */
export type SubjectGroup = (typeof SUBJECT_GROUPS)[number]["id"] | "unlisted"
export const subjectGroup = (id: string) => SUBJECT_GROUPS.find((g) => g.id === id)

export type SubjectsSort = "types" | "date" | "name"

export type SubjectRow = {
  /** The row's link: the pair member with more types. */
  id: string
  /** "Zeus · Jupiter" for a pair, Greek first. */
  names: string[]
  n: number
  /** Types in the Greek and the Roman collections, for a pair's "Greek 4,665 · Roman 1,475". */
  greek: number
  roman: number
  paired: boolean
  start: number | null
  end: number | null
  group: SubjectGroup
  photo: Photo | null
  /** Greek in `n`, Roman stacked above in `m` (every collection); one series in a collection. */
  bins: Bin[]
  /** Leaf collections, most types first: "Roman Imperial · 2 more". */
  collections: { id: string; name: string }[]
}

export type SubjectsGroup = { id: SubjectGroup; name: string; rows: SubjectRow[] }

export type SubjectsList = { tree: Tree; category: Category | null; groups: SubjectsGroup[]; total: number }

type Raw = {
  id: string; name: string; n: number; start: number | null; end: number | null; grp: SubjectGroup; pair: string | null
  greek: number; roman: number; bins: string | null; url: string | null; thumb: string | null; iiif: string | null
}

const ORDER: Record<SubjectsSort, (a: SubjectRow, b: SubjectRow) => number> = {
  types: (a, b) => b.n - a.n || a.names[0].localeCompare(b.names[0]),
  date: (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.n - a.n,
  name: (a, b) => a.names.join(" ").localeCompare(b.names.join(" ")),
}

export async function getSubjects(db: D1Database, categoryId: string | null, sort: SubjectsSort): Promise<SubjectsList | null> {
  const t = tree(await getCategories(db))
  const category = categoryId ? (t.byId.get(categoryId) ?? null) : null
  if (categoryId && (!category || category.subjects === 0)) return null

  // The half of the tree a collection sits in: Greek or Roman.
  const top = category ? ([...t.ancestors(category.id), category][0]?.id ?? null) : null
  const leaves = t.leaves(category?.id ?? null)
  const [rows, perLeaf] = await db.batch([
    category
      ? db
          .prepare(
            `SELECT s.id, s.name, c.n, c.start_year AS start, c.end_year AS "end", x.grp, x.pair_id AS pair,
               CASE WHEN ?2 = 'greek' THEN c.n ELSE 0 END AS greek, CASE WHEN ?2 = 'greek' THEN 0 ELSE c.n END AS roman,
               c.bins, ${IMAGE_COLS}
             FROM category_subject c JOIN subject_stat x ON x.subject_id = c.subject_id JOIN subject s ON s.id = c.subject_id
             LEFT JOIN image i ON i.id = c.image_id
             WHERE c.category_id = ?1 AND x.grp != 'unlisted'`
          )
          .bind(category.id, top)
      : db.prepare(
          `SELECT s.id, s.name, x.types AS n, x.start_year AS start, x.end_year AS "end", x.grp, x.pair_id AS pair,
             x.greek, x.roman, x.bins, ${IMAGE_COLS}
           FROM subject_stat x JOIN subject s ON s.id = x.subject_id LEFT JOIN image i ON i.id = x.image_id
           WHERE x.grp != 'unlisted'`
        ),
    db
      .prepare(`SELECT subject_id AS sub, category_id AS cat FROM category_subject
                WHERE category_id IN (${leaves.map(() => "?").join(",") || "NULL"}) ORDER BY n DESC`)
      .bind(...leaves.map((l) => l.id)),
  ])

  const collections = new Map<string, { id: string; name: string }[]>()
  for (const r of perLeaf.results as { sub: string; cat: string }[]) {
    const c = t.byId.get(r.cat)!
    if (!collections.has(r.sub)) collections.set(r.sub, [])
    collections.get(r.sub)!.push({ id: c.id, name: c.name })
  }

  const raw = new Map((rows.results as Raw[]).map((r) => [r.id, r]))
  const bins = (r: Raw): Bin[] =>
    category
      ? (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([start, n]) => ({ start, n }))
      : (JSON.parse(r.bins ?? "[]") as [number, number, number][]).map(([start, n, m]) => ({ start, n, m }))

  const list: SubjectRow[] = []
  const done = new Set<string>()
  for (const r of raw.values()) {
    if (done.has(r.id)) continue
    const other = r.pair ? raw.get(r.pair) : undefined
    const members = other ? [r, other] : [r]
    members.forEach((m) => done.add(m.id))
    // Greek first: the member with more types in the Greek collections.
    const named = [...members].sort((a, b) => b.greek - a.greek || a.roman - b.roman)
    const lead = [...members].sort((a, b) => b.n - a.n)[0]
    const merged = new Map<number, Bin>()
    for (const m of members)
      for (const b of bins(m)) {
        const x = merged.get(b.start) ?? { start: b.start, n: 0, m: category ? undefined : 0 }
        x.n += b.n
        if (b.m != null) x.m = (x.m ?? 0) + b.m
        merged.set(b.start, x)
      }
    const starts = members.map((m) => m.start).filter((v): v is number => v != null)
    const ends = members.map((m) => m.end).filter((v): v is number => v != null)
    const cols = members.flatMap((m) => collections.get(m.id) ?? [])
    list.push({
      id: lead.id,
      names: named.map((m) => m.name),
      n: members.reduce((a, m) => a + m.n, 0),
      greek: members.reduce((a, m) => a + m.greek, 0),
      roman: members.reduce((a, m) => a + m.roman, 0),
      paired: members.length > 1,
      start: starts.length ? Math.min(...starts) : null,
      end: ends.length ? Math.max(...ends) : null,
      group: lead.grp,
      photo: photo(lead),
      bins: [...merged.values()].sort((a, b) => a.start - b.start),
      collections: cols.filter((c, i) => cols.findIndex((x) => x.id === c.id) === i),
    })
  }
  list.sort(ORDER[sort])

  const groups = SUBJECT_GROUPS.map((g) => ({ id: g.id, name: g.name, rows: list.filter((r) => r.group === g.id) })).filter((g) => g.rows.length > 0)
  return { tree: t, category, groups, total: list.length }
}
