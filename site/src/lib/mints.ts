/*
 * Data for the mints list (/mints). Read from category_mint (pipeline/summaries.py): a row per mint per collection with
 * its count, dates and 25-year histogram, so the whole list is a few thousand small rows.
 *
 * "All collections" sums each mint's top-level rows: a type sits in one primary category, so a
 * mint struck for both Greek and Roman collections is never counted twice.
 */
import { tree, getCategories, type Category, type MapMint, type Tree } from "@/lib/categories"
import type { Bin } from "@/components/charts"

export const MINT_BIN = 25
/** Heading for mints with no region: workshops the catalogues could not place. */
export const UNCERTAIN = { id: "uncertain", name: "Uncertain mints" }

export type MintsSort = "region" | "date" | "types" | "name"

export type MintRow = {
  id: string
  name: string
  n: number
  start: number | null
  end: number | null
  region: string | null
  groupId: string
  bins: Bin[]
  /** The collections it struck for, most types first: "Roman Imperial · 2 more". */
  collections: { id: string; name: string }[]
}

export type MintGroup = { id: string; name: string; n: number; mints: MintRow[] }

export type MintsList = {
  tree: Tree
  category: Category | null
  /** In the chosen order; by region they also come grouped (`groups`). */
  rows: MintRow[]
  groups: MintGroup[]
  mapMints: MapMint[]
  located: number
}

type Raw = {
  id: string
  name: string
  n: number
  start: number | null
  end: number | null
  lon: number | null
  lat: number | null
  region: string | null
  groupId: string | null
  groupName: string | null
  bins: string | null
}

/** Merge "[[start, n], …]" histograms (one per top-level collection) into one, earliest first. */
function mergeBins(json: string[]): Bin[] {
  const sum = new Map<number, number>()
  for (const j of json) for (const [s, n] of JSON.parse(j) as [number, number][]) sum.set(s, (sum.get(s) ?? 0) + n)
  return [...sum].sort((a, b) => a[0] - b[0]).map(([start, n]) => ({ start, n }))
}

export async function getMints(db: D1Database, categoryId: string | null, sort: MintsSort): Promise<MintsList | null> {
  const t = tree(await getCategories(db))
  const category = categoryId ? (t.byId.get(categoryId) ?? null) : null
  if (categoryId && (!category || category.types === 0)) return null

  // The collections a mint struck for are the leaves under the chosen one.
  const leaves = t.leaves(category?.id ?? null)
  const scope = category ? `cm.category_id = ?1` : `cm.category_id IN (SELECT id FROM category WHERE parent_id IS NULL) AND ?1 IS NULL`
  const [mints, perLeaf] = await db.batch([
    db.prepare(`SELECT m.id, m.name, sum(cm.n) AS n, min(cm.start_year) AS start, max(cm.end_year) AS "end", m.lon, m.lat,
                  r.name AS region, g.id AS groupId, g.name AS groupName, json_group_array(cm.bins) AS bins,
                  g.sort_order AS gs, r.sort_order AS rs
                FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                LEFT JOIN region r ON r.id = m.region_id
                LEFT JOIN region_group g ON g.id = r.group_id
                WHERE ${scope}
                GROUP BY m.id
                ORDER BY ${{
                  region: `g.sort_order IS NULL, g.sort_order, n DESC, m.name`,
                  date: `start IS NULL, start, "end", n DESC, m.name`,
                  types: `n DESC, m.name`,
                  name: `m.name COLLATE NOCASE`,
                }[sort]}`).bind(category?.id ?? null),
    db.prepare(`SELECT cm.mint_id AS mint, cm.category_id AS cat FROM category_mint cm
                WHERE cm.category_id IN (${leaves.map(() => "?").join(",") || "NULL"}) ORDER BY cm.n DESC`).bind(...leaves.map((l) => l.id)),
  ])

  const collections = new Map<string, { id: string; name: string }[]>()
  for (const r of perLeaf.results as { mint: string; cat: string }[]) {
    const c = t.byId.get(r.cat)!
    if (!collections.has(r.mint)) collections.set(r.mint, [])
    collections.get(r.mint)!.push({ id: c.id, name: c.name })
  }

  const raw = mints.results as Raw[]
  const rows: MintRow[] = raw.map((m) => ({
    id: m.id,
    name: m.name,
    n: m.n,
    start: m.start,
    end: m.end,
    region: m.region,
    groupId: m.groupId ?? UNCERTAIN.id,
    // json_group_array of JSON text gives an array of strings; NULL bins (undated mints) drop out.
    bins: mergeBins((JSON.parse(m.bins ?? "[]") as (string | null)[]).filter((b): b is string => !!b)),
    collections: collections.get(m.id) ?? [],
  }))

  const groups = new Map<string, MintGroup>()
  if (sort === "region") {
    raw.forEach((m, i) => {
      const id = m.groupId ?? UNCERTAIN.id
      let g = groups.get(id)
      if (!g) groups.set(id, (g = { id, name: m.groupName ?? UNCERTAIN.name, n: 0, mints: [] }))
      g.mints.push(rows[i])
      g.n += m.n
    })
  }

  const mapMints = raw
    .filter((m): m is Raw & { lon: number; lat: number } => m.lon != null && m.lat != null)
    .map(({ id, name, n, lon, lat, start, end, region }) => ({ id, name, n, lon, lat, start, end, region }))
    .sort((a, b) => b.n - a.n)

  return { tree: t, category, rows, groups: [...groups.values()], mapMints, located: mapMints.length }
}
