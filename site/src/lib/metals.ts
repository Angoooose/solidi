/*
 * Data for the metal pages: /metals lists the four metals the site sorts by, and
 * /metal/gold shows one: its denominations measured in that metal, when and where it was struck,
 * who struck it, and its coinage with filters (lib/coinage.ts).
 *
 * The metals are the pipeline's METAL_GROUP (pipeline/summaries.py), the same four the
 * Denominations page groups by. The catalogues' finer alloys (orichalcum, billon, copper…) are
 * kept as what each type is "recorded as", and as a filter, not as metals of their own: they
 * mostly show which catalogue volumes record them.
 */
import { getCategories, photo, tree, IMAGE_COLS, type Category, type Photo } from "@/lib/categories"
import { COLLECTION, DENOMINATION, ISSUER, MATERIAL, MINT, cards, coinage, parseCommon, type Facet, type Sort } from "@/lib/coinage"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"

export const METAL_BIN = 25

/** The metals, in the order the catalogues' alloys roll up into them. */
export const METALS = [
  { id: "gold", name: "Gold" },
  { id: "silver", name: "Silver" },
  { id: "bronze", name: "Bronze" },
  { id: "electrum", name: "Electrum" },
] as const
export type MetalId = (typeof METALS)[number]["id"]
const metalName = (id: string) => METALS.find((m) => m.id === id)?.name ?? null

/* Denomination groups that aren't denominations: catalogue units (AE3) and placeholders. */
const NOT_DENOMINATIONS = `('units', 'unlisted')`
const NOT_PEOPLE = `('anonymous')`

export type MetalRow = {
  id: MetalId
  name: string
  types: number
  greek: number
  roman: number
  start: number | null
  end: number | null
  bins: Bin[]
  photo: Photo | null
  /** Its most struck denominations, by name. */
  denominations: string[]
}

export async function getMetals(db: D1Database): Promise<{ rows: MetalRow[]; types: number; unrecorded: number }> {
  const [stats, dens, counts] = await db.batch([
    db.prepare(`SELECT m.metal AS id, m.types, m.greek, m.roman, m.start_year AS start, m.end_year AS "end", m.bins, ${IMAGE_COLS}
                FROM metal_stat m LEFT JOIN image i ON i.id = m.image_id ORDER BY m.types DESC`),
    db.prepare(`SELECT md.metal, d.name FROM metal_denomination md JOIN denomination d ON d.id = md.denomination_id
                JOIN denomination_stat s ON s.denomination_id = md.denomination_id
                WHERE s.metal_group NOT IN ${NOT_DENOMINATIONS} ORDER BY md.types DESC, d.name`),
    db.prepare(`SELECT (SELECT count(DISTINCT type_id) FROM type_metal) AS recorded, (SELECT sum(types) FROM catalogue_stat) AS total`),
  ])
  const top = new Map<string, string[]>()
  for (const r of dens.results as { metal: string; name: string }[]) {
    const list = top.get(r.metal) ?? []
    if (list.length < 3) list.push(r.name)
    top.set(r.metal, list)
  }
  const c = counts.results[0] as { recorded: number; total: number }
  const rows = (stats.results as Raw[])
    .filter((r) => metalName(r.id))
    .map((r) => ({
      id: r.id as MetalId,
      name: metalName(r.id)!,
      types: r.types,
      greek: r.greek,
      roman: r.roman,
      start: r.start,
      end: r.end,
      bins: stacked(r.bins),
      photo: photo(r),
      denominations: top.get(r.id) ?? [],
    }))
  return { rows, types: c.recorded, unrecorded: c.total - c.recorded }
}

type Raw = { id: string; types: number; greek: number; roman: number; start: number | null; end: number | null; bins: string | null; url: string | null; thumb: string | null; iiif: string | null }
const stacked = (json: string | null): Bin[] => (JSON.parse(json ?? "[]") as [number, number, number][]).map(([start, n, m]) => ({ start, n, m }))

export type MetalQuery = {
  collection: string | null
  denomination: string | null
  issuer: string | null
  mint: string | null
  material: string | null
  sort: Sort
  limit: number
}

export function parseQuery(params: URLSearchParams): MetalQuery {
  const { slug, sort, limit } = parseCommon(params)
  return { collection: slug("collection"), denomination: slug("denomination"), issuer: slug("issuer"), mint: slug("mint"), material: slug("material"), sort, limit }
}

export type MetalDenomination = { id: string; name: string; types: number; start: number | null; end: number | null; weight: number | null; diameter: number | null }
export type MetalCollection = { category: Category; n: number; start: number | null; end: number | null; bins: Bin[] }

export type Metal = {
  id: MetalId
  name: string
  types: number
  greek: number
  roman: number
  start: number | null
  end: number | null
  specimens: number
  holders: number
  photo: Photo | null
  /** What the catalogues record these types as: bronze, billon, orichalcum… Only when more than one. */
  recorded: { id: string; name: string; n: number }[]
  /** Its most struck denominations, measured on coins of this metal. */
  denominations: MetalDenomination[]
  collections: MetalCollection[]
  people: { items: Facet[]; total: number }
  mints: { items: Facet[]; total: number }
  available: { collection: boolean; denomination: boolean; issuer: boolean; mint: boolean; material: boolean }
  collectionFacet: Facet[]
  denominationFacet: Facet[]
  issuerFacet: Facet[]
  mintFacet: Facet[]
  materialFacet: Facet[]
  total: number
  grid: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

/* Every live type in the metal (?1). */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.id IN (SELECT type_id FROM type_metal WHERE metal = ?1)`
const FILTERS = [COLLECTION, DENOMINATION, ISSUER, MINT, MATERIAL]
/** Denominations listed before "All gold denominations". */
const DENOMINATIONS = 6

export async function getMetal(db: D1Database, id: string, query: MetalQuery): Promise<Metal | null> {
  const name = metalName(id)
  if (!name) return null
  const m = await db
    .prepare(`SELECT m.*, ${IMAGE_COLS} FROM metal_stat m LEFT JOIN image i ON i.id = m.image_id WHERE m.metal = ?`)
    .bind(id)
    .first<{
      types: number; greek: number; roman: number; start_year: number | null; end_year: number | null; collections: number
      people: number; mints: number; specimens: number; holders: number; materials: string
      url: string | null; thumb: string | null; iiif: string | null
    }>()
  if (!m) return null

  const t = tree(await getCategories(db))
  const c = coinage(db, id, BASE, FILTERS, [query.collection, query.denomination, query.issuer, query.mint, query.material])
  const { one } = c
  const [materials, dens, perCollection, people, mints, collectionFacet, denominationFacet, issuerFacet, mintFacet, materialFacet, total, types] =
    await db.batch([
      db.prepare(`SELECT id, name FROM material`),
      one(`SELECT md.denomination_id AS id, d.name, md.types, md.start_year AS start, md.end_year AS "end", md.weight, md.diameter
           FROM metal_denomination md JOIN denomination d ON d.id = md.denomination_id
           JOIN denomination_stat s ON s.denomination_id = md.denomination_id
           WHERE md.metal = ?1 AND s.metal_group NOT IN ${NOT_DENOMINATIONS} ORDER BY md.types DESC, d.name LIMIT ${DENOMINATIONS}`),
      one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", bins FROM category_metal WHERE metal = ?1`),
      one(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer') JOIN person p ON p.id = tp.person_id
           WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE} GROUP BY p.id ORDER BY count DESC, p.name LIMIT 600`),
      one(`SELECT coalesce(pm.id, mn.id) AS value, coalesce(pm.name, mn.name) AS label, count(*) AS count
           FROM coin_type t JOIN mint mn ON mn.id = t.mint_id LEFT JOIN mint pm ON pm.id = mn.parent_id
           WHERE ${BASE} GROUP BY value ORDER BY count DESC, label`),
      c.collectionFacet(),
      c.denominationFacet(),
      c.issuerFacet(),
      c.mintFacet(),
      c.materialFacet(),
      c.total(),
      c.types(query.sort, query.limit),
    ])

  const materialName = new Map((materials.results as { id: string; name: string }[]).map((r) => [r.id, r.name]))
  const recorded = (JSON.parse(m.materials) as [string, number][]).map(([mid, n]) => ({ id: mid, name: materialName.get(mid) ?? mid, n }))
  const collections = (perCollection.results as { id: string; n: number; start: number | null; end: number | null; bins: string | null }[])
    .filter((r) => t.byId.has(r.id) && t.isLeaf(r.id))
    .map((r) => ({
      category: t.byId.get(r.id)!,
      n: r.n,
      start: r.start,
      end: r.end,
      bins: (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([start, n]) => ({ start, n })),
    }))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.n - a.n)
  const grid = await cards(db, types)
  const facet = (r: D1Result) => r.results as Facet[]

  return {
    id: id as MetalId,
    name,
    types: m.types,
    greek: m.greek,
    roman: m.roman,
    start: m.start_year,
    end: m.end_year,
    specimens: m.specimens,
    holders: m.holders,
    photo: photo(m),
    recorded: recorded.length > 1 ? recorded : [],
    denominations: dens.results as MetalDenomination[],
    collections,
    people: { items: facet(people), total: m.people },
    mints: { items: facet(mints), total: m.mints },
    available: { collection: collections.length > 1, denomination: true, issuer: m.people > 1, mint: m.mints > 1, material: recorded.length > 1 },
    collectionFacet: facet(collectionFacet),
    denominationFacet: facet(denominationFacet),
    issuerFacet: facet(issuerFacet),
    mintFacet: facet(mintFacet),
    materialFacet: facet(materialFacet),
    total: (total.results[0] as { n: number }).n,
    grid: grid.types,
    typeCredits: grid.typeCredits,
  }
}
