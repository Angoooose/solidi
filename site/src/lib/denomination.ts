/*
 * Data for the denomination page (/denomination/tetradrachm):
 * what it was (Wikipedia, else Nomisma's definition), its metal and size, how it compares with
 * what its top collections struck beside it (denomination_size), where it was struck
 * (category_denomination: dates, histogram, median weight), who issued it, its mints and
 * subjects, and its coinage with filters (lib/coinage.ts).
 */
import { getCategories, photo, tree, IMAGE_COLS, type Category, type Photo } from "@/lib/categories"
import { COLLECTION, ISSUER, MINT, PHOTO, cards, coinage, collectionKeys, denominationBase, issuerKeys, mintKeys, parseCommon, type Facet, type PhotoToggle, type Sort } from "@/lib/coinage"
import { facetIndex } from "@/lib/facet/store"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"
import { lead } from "@/lib/format"
import { metalGroup, type MetalGroup } from "@/lib/denominations"

const NOT_PEOPLE = `('anonymous')`

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

/* Every live type of the denomination (?1), for the sections read from D1; the coinage grid takes
 * the same set from the facet index (denominationBase). */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.id IN (SELECT type_id FROM type_denomination WHERE denomination_id = ?1)`
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
  const one = (sql: string) => db.prepare(sql).bind(id)

  const [[article, perCollection, sizes, people, mints, subjects], grid] = await Promise.all([db.batch([
    one(`SELECT extract, url, licence FROM article WHERE entity_type = 'denomination' AND entity_id = ?1
         ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
    one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", weight, bins FROM category_denomination WHERE denomination_id = ?1`),
    one(`SELECT z.category_id AS cat, z.tab, z.window_start AS ws, z.window_end AS we, z.other_id AS other, o.name, z.diameter, ${IMAGE_COLS}
         FROM denomination_size z JOIN denomination o ON o.id = z.other_id
         LEFT JOIN category_denomination cd ON cd.category_id = z.category_id AND cd.denomination_id = z.other_id
         LEFT JOIN image i ON i.id = cd.image_id
         WHERE z.denomination_id = ?1 ORDER BY z.tab, z.diameter DESC`),
    one(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
         FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer') JOIN person p ON p.id = tp.person_id
         WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE} GROUP BY p.id ORDER BY count DESC, p.name`),
    one(`SELECT coalesce(pm.id, m.id) AS value, coalesce(pm.name, m.name) AS label, count(*) AS count
         FROM coin_type t JOIN mint m ON m.id = t.mint_id LEFT JOIN mint pm ON pm.id = m.parent_id
         WHERE ${BASE} GROUP BY value ORDER BY count DESC, label`),
    one(`SELECT x.id AS value, x.name AS label, count(DISTINCT t.id) AS count
         FROM coin_type t JOIN type_subject j ON j.type_id = t.id JOIN subject x ON x.id = j.subject_id
         WHERE ${BASE} GROUP BY x.id ORDER BY count DESC, x.name`),
  ]), cards(db, c.grid(query.sort, query.limit))])

  const rows = perCollection.results as { id: string; n: number; start: number | null; end: number | null; weight: number | null; bins: string | null }[]
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

  type SizeRaw = { cat: string; tab: number; ws: number | null; we: number | null; other: string; name: string; diameter: number; url: string | null; thumb: string | null; iiif: string | null }
  const tabs = new Map<number, SizeTab>()
  for (const r of sizes.results as SizeRaw[]) {
    if (!tabs.has(r.tab)) tabs.set(r.tab, { category: { id: r.cat, name: t.byId.get(r.cat)?.name ?? r.cat }, start: r.ws, end: r.we, coins: [] })
    tabs.get(r.tab)!.coins.push({ id: r.other, name: r.name, diameter: r.diameter, photo: photo(r) })
  }

  const art = article.results[0] as { extract: string; url: string; licence: string } | undefined
  const all = (r: D1Result, total: number) => ({ items: r.results as Facet[], total })

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
