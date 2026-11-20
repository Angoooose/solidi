/*
 * Data for the denominations list (/denominations). Read from denomination_stat and category_denomination (pipeline/summaries.py): a
 * row per denomination, or per denomination in a collection, with its count, dates, 25-year
 * histogram, median diameter and a photo.
 */
import { tree, getCategories, photo, IMAGE_COLS, type Category, type Photo, type Tree } from "@/lib/categories"
import type { Bin } from "@/components/charts"

export const DENOMINATION_BIN = 25

/** The list's headings, in order. A denomination sits under its most common metal's group. */
export const METAL_GROUPS = [
  { id: "gold", name: "Gold" },
  { id: "electrum", name: "Electrum" },
  { id: "silver", name: "Silver" },
  { id: "bronze", name: "Bronze and copper" },
  { id: "units", name: "Catalogue units" },
] as const
export type MetalGroup = (typeof METAL_GROUPS)[number]["id"]
export const groupName = (id: string) => METAL_GROUPS.find((g) => g.id === id)?.name ?? id

export type DenominationsSort = "metal" | "types" | "date" | "name"

export type DenominationRow = {
  id: string
  name: string
  n: number
  start: number | null
  end: number | null
  group: MetalGroup
  material: string | null
  also: string | null
  /** Median diameter of measured specimens, mm. */
  diameter: number | null
  photo: Photo | null
  bins: Bin[]
  /** The collections it was struck in, most types first: "Roman Imperial · 2 more". */
  collections: { id: string; name: string }[]
}

export type DenominationGroup = { id: MetalGroup; name: string; n: number; rows: DenominationRow[] }

export type DenominationsList = {
  tree: Tree
  category: Category | null
  rows: DenominationRow[]
  groups: DenominationGroup[]
}

/** "19.8 mm · also silver"; catalogue units name their metal first, since their heading doesn't. */
export function sizeLine(d: { group: string; material: string | null; also: string | null; diameter: number | null }): string {
  return [
    d.group === "units" ? d.material : null,
    d.diameter != null ? `${d.diameter} mm` : null,
    d.also ? `also ${d.also.toLowerCase()}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

type Raw = {
  id: string
  name: string
  n: number
  start: number | null
  end: number | null
  grp: MetalGroup
  material: string | null
  also: string | null
  diameter: number | null
  bins: string | null
  url: string | null
  thumb: string | null
  iiif: string | null
}

const ORDER: Record<DenominationsSort, string> = {
  metal: `n DESC, d.name`,
  types: `n DESC, d.name`,
  date: `start IS NULL, start, "end", n DESC, d.name`,
  name: `d.name COLLATE NOCASE`,
}

export async function getDenominations(db: D1Database, categoryId: string | null, sort: DenominationsSort): Promise<DenominationsList | null> {
  const t = tree(await getCategories(db))
  const category = categoryId ? (t.byId.get(categoryId) ?? null) : null
  if (categoryId && (!category || category.types === 0)) return null

  const leaves = t.leaves(category?.id ?? null)
  // One collection reads its own counts, sizes and photos; every collection reads the totals.
  const [source, n, where] = category ? [`category_denomination`, `x.n`, `x.category_id = ?1`] : [`denomination_stat`, `x.types`, `?1 IS NULL`]
  const [rows, perLeaf] = await db.batch([
    db
      .prepare(
        `SELECT d.id, d.name, ${n} AS n, x.start_year AS start, x.end_year AS "end", s.metal_group AS grp,
           m.name AS material, a.name AS also, x.diameter, x.bins, ${IMAGE_COLS}
         FROM ${source} x JOIN denomination_stat s ON s.denomination_id = x.denomination_id
         JOIN denomination d ON d.id = x.denomination_id
         LEFT JOIN material m ON m.id = s.material_id LEFT JOIN material a ON a.id = s.also_id
         LEFT JOIN image i ON i.id = x.image_id
         WHERE ${where}
         ORDER BY ${ORDER[sort]}`
      )
      .bind(category?.id ?? null),
    db
      .prepare(`SELECT denomination_id AS den, category_id AS cat FROM category_denomination
                WHERE category_id IN (${leaves.map(() => "?").join(",") || "NULL"}) ORDER BY n DESC`)
      .bind(...leaves.map((l) => l.id)),
  ])

  const collections = new Map<string, { id: string; name: string }[]>()
  for (const r of perLeaf.results as { den: string; cat: string }[]) {
    const c = t.byId.get(r.cat)!
    if (!collections.has(r.den)) collections.set(r.den, [])
    collections.get(r.den)!.push({ id: c.id, name: c.name })
  }

  const list: DenominationRow[] = (rows.results as Raw[]).map((r) => ({
    id: r.id,
    name: r.name,
    n: r.n,
    start: r.start,
    end: r.end,
    group: r.grp,
    material: r.material,
    also: r.also,
    diameter: r.diameter,
    photo: photo(r),
    bins: (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([start, n]) => ({ start, n })),
    collections: collections.get(r.id) ?? [],
  }))

  const groups: DenominationGroup[] =
    sort === "metal"
      ? METAL_GROUPS.map((g) => {
          const rows = list.filter((r) => r.group === g.id)
          return { id: g.id, name: g.name, n: rows.reduce((a, r) => a + r.n, 0), rows }
        }).filter((g) => g.rows.length > 0)
      : []

  return { tree: t, category, rows: list, groups }
}
