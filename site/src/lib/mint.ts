/*
 * Data for the mint page (/mint/antiocheia_syria): the mint and where it is,
 * its output per collection over time (category_mint), who struck there, its denominations, metals
 * and subjects, and its coinage with filters (lib/coinage.ts).
 *
 * A mint covers its workshops (Seleucia on the Tigris II is part of Seleucia), as the summary
 * tables count them; a workshop's own URL redirects to its city. Counts are of live types, not
 * sub-variants (the type counting rule), so they match the mints list.
 */
import { getCategories, tree, type Category, type MapMint } from "@/lib/categories"
import { COLLECTION, DENOMINATION, ISSUER, MATERIAL, PHOTO, cards, coinage, parseCommon, photoToggle, type Facet, type PhotoToggle, type Sort } from "@/lib/coinage"
import { lead } from "@/lib/format"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"
import { MINT_BIN } from "@/lib/mints"

/** "Who struck here" shows this many before "All N people". */
export const PEOPLE_SHOWN = 20
const FACETS = 8
const NOT_PEOPLE = `('anonymous')`

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

/* Every live type struck at the mint (?1) or one of its workshops. */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.mint_id IN (SELECT id FROM mint WHERE id = ?1 OR parent_id = ?1)`
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

  const t = tree(await getCategories(db))
  const c = coinage(db, id, BASE, FILTERS, [query.collection, query.issuer, query.denomination, query.material, query.photo])
  const { one } = c
  const facet = (join: string, table: string) =>
    one(`SELECT x.id AS value, x.name AS label, count(DISTINCT t.id) AS count
         FROM coin_type t JOIN ${join} j ON j.type_id = t.id JOIN ${table} x ON x.id = j.${table}_id
         WHERE ${BASE} GROUP BY x.id ORDER BY count DESC, x.name`)

  const [article, perCollection, stats, people, denominations, materials, subjects, collectionFacet, issuerFacet, denominationFacet, materialFacet, total, photoRows, types] =
    await db.batch([
      one(`SELECT extract, url, licence FROM article WHERE entity_type = 'mint' AND entity_id = ?1
           ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
      one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", bins FROM category_mint WHERE mint_id = ?1`),
      one(`SELECT count(DISTINCT st.specimen_id) AS specimens, count(DISTINCT s.institution_id) AS holders
           FROM coin_type t JOIN specimen_type st ON st.type_id = t.id JOIN specimen s ON s.id = st.specimen_id WHERE ${BASE}`),
      one(`SELECT p.id, p.name, p.start_year AS os, coalesce(p.end_year, p.start_year) AS oe, count(DISTINCT t.id) AS n,
             min(t.start_year) AS cs, max(coalesce(t.end_year, t.start_year)) AS ce
           FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer')
           JOIN person p ON p.id = tp.person_id
           WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE}
           GROUP BY p.id
           ORDER BY coalesce(os, cs) IS NULL, coalesce(os, cs), coalesce(oe, ce), n DESC, p.name`),
      facet("type_denomination", "denomination"),
      facet("type_material", "material"),
      facet("type_subject", "subject"),
      c.collectionFacet(),
      c.issuerFacet(),
      c.denominationFacet(),
      c.materialFacet(),
      c.total(),
      c.photoFacet(),
      c.types(query.sort, query.limit),
    ])

  const rows = perCollection.results as { id: string; n: number; start: number | null; end: number | null; bins: string | null }[]
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
  type PersonRaw = { id: string; name: string; n: number; os: number | null; oe: number | null; cs: number | null; ce: number | null }
  const art = article.results[0] as { extract: string; url: string; licence: string } | undefined
  const st = stats.results[0] as { specimens: number; holders: number }
  const top = (r: D1Result) => {
    const items = r.results as Facet[]
    return { items: items.slice(0, FACETS), total: items.length }
  }
  const unfiltered = { denomination: (denominations.results as Facet[]).length, material: (materials.results as Facet[]).length }
  const grid_ = await cards(db, types)
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
    people: (people.results as PersonRaw[]).map((p) => ({ id: p.id, name: p.name, n: p.n, office: span(p.os, p.oe), coins: span(p.cs, p.ce) })),
    denominations: top(denominations),
    materials: top(materials),
    subjects: top(subjects),
    available: {
      collection: collections.length > 1,
      issuer: (people.results as unknown[]).length > 1,
      denomination: unfiltered.denomination > 1,
      material: unfiltered.material > 1,
    },
    collectionFacet: collectionFacet.results as Facet[],
    issuerFacet: issuerFacet.results as Facet[],
    denominationFacet: denominationFacet.results as Facet[],
    materialFacet: materialFacet.results as Facet[],
    photographed: photoToggle(photoRows),
    total: (total.results[0] as { n: number }).n,
    grid: grid_.types,
    typeCredits: grid_.typeCredits,
  }
}

export { MINT_BIN }
