/*
 * Data for the mint page (/mint/antiocheia_syria): the mint and where it is,
 * its output per collection over time (category_mint), who struck there, its denominations, metals
 * and subjects (computed when the database is built: lib/summary/), and its coinage with filters
 * (lib/coinage.ts).
 *
 * A mint covers its workshops (Seleucia on the Tigris II is part of Seleucia), as the summary
 * tables count them; a workshop's own URL redirects to its city. Counts are of live types, not
 * sub-variants (the type counting rule), so they match the mints list.
 */
import { getCategories, tree, type Category, type MapMint } from "@/lib/categories"
import { COLLECTION, DENOMINATION, ISSUER, MATERIAL, PHOTO, cards, coinage, collectionKeys, denominationKeys, issuerKeys, materialKeys, mintBase, parseCommon, type Facet, type PhotoToggle, type Sort } from "@/lib/coinage"
import { facetIndex } from "@/lib/facet/store"
import { sections } from "@/lib/summary/store"
import { lead } from "@/lib/format"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"
import { MINT_BIN } from "@/lib/mints"

/** "Who struck here" shows this many before "All N people". */
export const PEOPLE_SHOWN = 20
const FACETS = 8

export type MintQuery = {
  collection: string | null
  issuer: string | null
  denomination: string | null
  material: string | null
  sort: Sort
  limit: number
  /** "1": only types with a photograph. */
  photo: string | null
}

export function parseQuery(params: URLSearchParams): MintQuery {
  const { slug, photo, sort, limit } = parseCommon(params)
  return { collection: slug("collection"), issuer: slug("issuer"), denomination: slug("denomination"), material: slug("material"), photo, sort, limit }
}

type Span = [number, number]
export type MintPerson = { id: string; name: string; n: number; office: Span | null; coins: Span | null }
export type MintCollection = { category: Category; n: number; start: number | null; end: number | null; bins: Bin[] }

export type Mint = {
  id: string
  name: string
  start: number | null
  end: number | null
  lead: string | null
  article: { url: string; licence: string } | null
  region: { id: string; name: string } | null
  group: { id: string; name: string } | null
  location: MapMint | null
  types: number
  specimens: number
  holders: number
  /** Leaf collections it struck for, earliest first. */
  collections: MintCollection[]
  /** Everyone who issued coins here, earliest first. */
  people: MintPerson[]
  denominations: { items: Facet[]; total: number }
  materials: { items: Facet[]; total: number }
  subjects: { items: Facet[]; total: number }
  /** The coinage grid. */
  available: { collection: boolean; issuer: boolean; denomination: boolean; material: boolean }
  collectionFacet: Facet[]
  issuerFacet: Facet[]
  denominationFacet: Facet[]
  materialFacet: Facet[]
  /** The "Photographed" toggle. */
  photographed: PhotoToggle
  total: number
  grid: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

const FILTERS = [COLLECTION, ISSUER, DENOMINATION, MATERIAL, PHOTO]

export async function getMint(db: D1Database, id: string, query: MintQuery): Promise<Mint | { redirect: string } | null> {
  const mint = await db
    .prepare(`SELECT m.id, m.name, m.definition, m.parent_id AS parent, coalesce(m.lon, p.lon) AS lon, coalesce(m.lat, p.lat) AS lat,
                r.id AS regionId, r.name AS region, g.id AS groupId, g.name AS groupName
              FROM mint m LEFT JOIN mint p ON p.id = m.parent_id
              LEFT JOIN region r ON r.id = m.region_id LEFT JOIN region_group g ON g.id = r.group_id
              WHERE m.id = ?`)
    .bind(id)
    .first<{ id: string; name: string; definition: string | null; parent: string | null; lon: number | null; lat: number | null
      regionId: string | null; region: string | null; groupId: string | null; groupName: string | null }>()
  if (!mint) return null
  if (mint.parent) return { redirect: mint.parent }

  const [t, ix] = await Promise.all([getCategories(db).then(tree), facetIndex(db)])
  const c = coinage(ix, mintBase(ix, id), FILTERS, [query.collection, query.issuer, query.denomination, query.material, query.photo])
  const [{ article, perCollection, stats, people, denominations, materials, subjects }, grid_] = await Promise.all([
    sections(db, "mint", id),
    cards(db, c.grid(query.sort, query.limit)),
  ])

  const rows = perCollection
  const tops = rows.filter((r) => t.byId.get(r.id)?.parentId == null)
  const sum = (f: (r: (typeof rows)[number]) => number | null, pick: (a: number[]) => number) => {
    const v = tops.map(f).filter((x): x is number => x != null)
    return v.length ? pick(v) : null
  }
  const start = sum((r) => r.start, (a) => Math.min(...a))
  const end = sum((r) => r.end, (a) => Math.max(...a))
  const collections = rows
    .filter((r) => t.byId.has(r.id) && t.isLeaf(r.id))
    .map((r) => ({
      category: t.byId.get(r.id)!,
      n: r.n,
      start: r.start,
      end: r.end,
      bins: (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([s, n]) => ({ start: s, n })),
    }))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.n - a.n)

  const span = (s: number | null, e: number | null): Span | null => (s == null ? null : [Math.min(s, e ?? s), Math.max(s, e ?? s)])
  const art = article[0] as (typeof article)[number] | undefined
  const st = stats[0]
  const top = (items: Facet[]) => ({ items: items.slice(0, FACETS), total: items.length })
  const unfiltered = { denomination: denominations.length, material: materials.length }
  const n = tops.reduce((a, r) => a + r.n, 0)

  return {
    id: mint.id,
    name: mint.name,
    start,
    end,
    lead: lead(art?.extract ?? mint.definition, 420),
    article: art ? { url: art.url, licence: art.licence } : null,
    region: mint.regionId ? { id: mint.regionId, name: mint.region! } : null,
    group: mint.groupId ? { id: mint.groupId, name: mint.groupName! } : null,
    location:
      mint.lon != null && mint.lat != null
        ? { id: mint.id, name: mint.name, n, lon: mint.lon, lat: mint.lat, start, end, region: mint.region }
        : null,
    types: n,
    specimens: st.specimens,
    holders: st.holders,
    collections,
    people: people.map((p) => ({ id: p.id, name: p.name, n: p.n, office: span(p.os, p.oe), coins: span(p.cs, p.ce) })),
    denominations: top(denominations),
    materials: top(materials),
    subjects: top(subjects),
    available: {
      collection: collections.length > 1,
      issuer: people.length > 1,
      denomination: unfiltered.denomination > 1,
      material: unfiltered.material > 1,
    },
    collectionFacet: c.facet("collection", collectionKeys(ix), ix.categories),
    issuerFacet: c.facet("issuer", issuerKeys(ix), ix.persons),
    denominationFacet: c.facet("denomination", denominationKeys(ix), ix.denominations),
    materialFacet: c.facet("material", materialKeys(ix), ix.materials),
    photographed: c.photo(),
    total: c.total(),
    grid: grid_.types,
    typeCredits: grid_.typeCredits,
  }
}

export { MINT_BIN }
