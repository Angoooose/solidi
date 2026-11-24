/*
 * Data for the denomination page (/denomination/tetradrachm):
 * what it was (Wikipedia, else Nomisma's definition), its metal and size, how it compares with
 * what its top collections struck beside it (denomination_size), where it was struck
 * (category_denomination: dates, histogram, median weight), who issued it, its mints and
 * subjects (computed when the database is built: lib/summary/), and its coinage with filters
 * (lib/coinage.ts).
 */
import { getCategories, photo, tree, IMAGE_COLS, type Category, type Photo } from "@/lib/categories"
import { COLLECTION, ISSUER, MINT, PHOTO, cards, coinage, collectionKeys, denominationBase, issuerKeys, mintKeys, parseCommon, type Facet, type PhotoToggle, type Sort } from "@/lib/coinage"
import { facetIndex } from "@/lib/facet/store"
import { sections } from "@/lib/summary/store"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"
import { lead } from "@/lib/format"
import { metalGroup, type MetalGroup } from "@/lib/denominations"

export type DenominationQuery = {
  collection: string | null
  issuer: string | null
  mint: string | null
  sort: Sort
  limit: number
  /** "1": only types with a photograph. */
  photo: string | null
}

export function parseQuery(params: URLSearchParams): DenominationQuery {
  const { slug, photo, sort, limit } = parseCommon(params)
  return { collection: slug("collection"), issuer: slug("issuer"), mint: slug("mint"), photo, sort, limit }
}

export type SizeTab = {
  category: { id: string; name: string }
  start: number | null
  end: number | null
  coins: { id: string; name: string; diameter: number; photo: Photo | null }[]
}

export type DenominationCollection = { category: Category; n: number; start: number | null; end: number | null; weight: number | null; bins: Bin[] }

export type Denomination = {
  id: string
  name: string
  lead: string | null
  article: { url: string; licence: string } | null
  /** Its heading on /denominations; null for one that isn't listed. */
  group: { id: MetalGroup; name: string } | null
  material: string | null
  also: string | null
  start: number | null
  end: number | null
  types: number
  diameter: number | null
  weight: number | null
  specimens: number
  holders: number
  photo: Photo | null
  sizes: SizeTab[]
  /** Leaf collections it was struck in, earliest first. */
  collections: DenominationCollection[]
  people: { items: Facet[]; total: number }
  mints: { items: Facet[]; total: number }
  subjects: { items: Facet[]; total: number }
  available: { collection: boolean; issuer: boolean; mint: boolean }
  collectionFacet: Facet[]
  issuerFacet: Facet[]
  mintFacet: Facet[]
  /** The "Photographed" toggle. */
  photographed: PhotoToggle
  total: number
  grid: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

const FILTERS = [COLLECTION, ISSUER, MINT, PHOTO]

export async function getDenomination(db: D1Database, id: string, query: DenominationQuery): Promise<Denomination | null> {
  const d = await db
    .prepare(`SELECT d.id, d.name, d.definition, s.metal_group AS grp, m.name AS material, a.name AS also, s.types, s.start_year AS start,
                s.end_year AS "end", s.diameter, s.weight, s.specimens, s.holders, s.people, s.mints, s.subjects, ${IMAGE_COLS}
              FROM denomination d JOIN denomination_stat s ON s.denomination_id = d.id
              LEFT JOIN material m ON m.id = s.material_id LEFT JOIN material a ON a.id = s.also_id
              LEFT JOIN image i ON i.id = s.image_id
              WHERE d.id = ?`)
    .bind(id)
    .first<{
      id: string; name: string; definition: string | null; grp: MetalGroup; material: string | null; also: string | null
      types: number; start: number | null; end: number | null; diameter: number | null; weight: number | null
      specimens: number; holders: number; people: number; mints: number; subjects: number
      url: string | null; thumb: string | null; iiif: string | null
    }>()
  if (!d) return null

  const [t, ix] = await Promise.all([getCategories(db).then(tree), facetIndex(db)])
  const c = coinage(ix, denominationBase(ix, id), FILTERS, [query.collection, query.issuer, query.mint, query.photo])
  const [{ article, perCollection, sizes, people, mints, subjects }, grid] = await Promise.all([
    sections(db, "denomination", id),
    cards(db, c.grid(query.sort, query.limit)),
  ])

  const rows = perCollection
  const collections = rows
    .filter((r) => t.byId.has(r.id) && t.isLeaf(r.id))
    .map((r) => ({
      category: t.byId.get(r.id)!,
      n: r.n,
      start: r.start,
      end: r.end,
      weight: r.weight,
      bins: (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([s, n]) => ({ start: s, n })),
    }))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.n - a.n)

  const tabs = new Map<number, SizeTab>()
  for (const r of sizes) {
    if (!tabs.has(r.tab)) tabs.set(r.tab, { category: { id: r.cat, name: t.byId.get(r.cat)?.name ?? r.cat }, start: r.ws, end: r.we, coins: [] })
    tabs.get(r.tab)!.coins.push({ id: r.other, name: r.name, diameter: r.diameter, photo: photo(r) })
  }

  const art = article[0] as (typeof article)[number] | undefined
  const all = (items: Facet[], total: number) => ({ items, total })

  return {
    id: d.id,
    name: d.name,
    lead: lead(art?.extract ?? d.definition, 420),
    article: art ? { url: art.url, licence: art.licence } : null,
    group: metalGroup(d.grp) ?? null,
    material: d.material,
    also: d.also,
    start: d.start,
    end: d.end,
    types: d.types,
    diameter: d.diameter,
    weight: d.weight,
    specimens: d.specimens,
    holders: d.holders,
    photo: photo(d),
    sizes: [...tabs.values()].filter((s) => s.coins.length > 1),
    collections,
    people: all(people, d.people),
    mints: all(mints, d.mints),
    subjects: all(subjects, d.subjects),
    available: { collection: collections.length > 1, issuer: d.people > 1, mint: d.mints > 1 },
    collectionFacet: c.facet("collection", collectionKeys(ix), ix.categories),
    issuerFacet: c.facet("issuer", issuerKeys(ix), ix.persons),
    mintFacet: c.facet("mint", mintKeys(ix), ix.mints),
    photographed: c.photo(),
    total: c.total(),
    grid: grid.types,
    typeCredits: grid.typeCredits,
  }
}
