/*
 * Data for the collection pages (/collections, /category/[id], /rulers?collection=) and the
 * header's Collections menu. Everything is read from the summary tables the pipeline writes
 * (pipeline/summaries.py: category_stat, _bin, _facet, _person, _mint), so a page reads tens to
 * hundreds of rows, never the coin types themselves.
 */
import { iiif, secure, yearRange } from "@/lib/format"

/* City coinages are browsed by mint; their "rulers" are magistrates and client kings. */
export const BY_MINT = new Set(["archaic-classical", "hellenistic-cities", "roman-provincial"])

/* What a category's people are called. */
const PEOPLE: Record<string, { one: string; many: string }> = {
  "roman-imperial": { one: "emperor", many: "emperors" },
  "roman-republican": { one: "moneyer", many: "moneyers" },
  "roman-imperatorial": { one: "issuer", many: "issuers" },
}
export function peopleNoun(categoryId: string | null) {
  return (categoryId && PEOPLE[categoryId]) || { one: "ruler", many: "rulers" }
}

export const fmt = (n: number) => Math.round(n).toLocaleString("en-GB")
export const typesLabel = (n: number) => `${fmt(n)} ${Math.round(n) === 1 ? "type" : "types"}`
/** "320–46 BC · 2,555 types" */
export const metaLine = (s: number | null, e: number | null, n: number) => [yearRange(s, e), typesLabel(n)].filter(Boolean).join(" · ")

export type Photo = { thumb: string | null; large: string | null }
type ImageCols = { url: string | null; thumb: string | null; iiif: string | null }
/* thumb: small rows and menus (static ~175px files where the holder has them); large: cards. */
function photo(r: ImageCols): Photo | null {
  if (!r.url && !r.iiif) return null
  return {
    thumb: secure(r.thumb) ?? iiif(r.iiif, 160) ?? secure(r.url),
    large: iiif(r.iiif, 600) ?? secure(r.url) ?? secure(r.thumb),
  }
}
const IMAGE_COLS = `i.url, i.thumbnail_url AS thumb, i.iiif_service AS iiif`

export type Category = {
  id: string
  name: string
  description: string | null
  parentId: string | null
  sortOrder: number
  types: number
  start: number | null
  end: number | null
  photographed: number
  people: number
  mints: number
  mintsLocated: number
  regions: number
  denominations: number
  subjects: number
}

const CATEGORY_SELECT = `
  SELECT c.id, c.name, c.description, c.parent_id AS parentId, c.sort_order AS sortOrder,
    s.types, s.start_year AS start, s.end_year AS "end", s.photographed, s.people, s.mints,
    s.mints_located AS mintsLocated, s.regions, s.denominations, s.subjects
  FROM category c JOIN category_stat s ON s.category_id = c.id`

export type Bin = { start: number; n: number }
export type PersonCard = { id: string; name: string; n: number; start: number | null; end: number | null; datedBy: string | null; photo: Photo | null }
export type MintCard = { id: string; name: string; n: number; start: number | null; end: number | null; region: string | null; photo: Photo | null }
export type Facet = { id: string; name: string; n: number }

/** The whole tree with totals, in sort order. Small (15 rows): every page reads it. */
export async function getCategories(db: D1Database): Promise<Category[]> {
  const { results } = await db.prepare(`${CATEGORY_SELECT} ORDER BY c.sort_order, c.name`).all<Category>()
  return results
}

export type Tree = {
  all: Category[]
  byId: Map<string, Category>
  children: (id: string | null) => Category[]
  isLeaf: (id: string) => boolean
  /** Broadest first, not including the category itself. */
  ancestors: (id: string) => Category[]
  /** Leaves under a category (itself if it is one), in tree order. */
  leaves: (id: string | null) => Category[]
}

export function tree(all: Category[]): Tree {
  const byId = new Map(all.map((c) => [c.id, c]))
  const children = (id: string | null) => all.filter((c) => c.parentId === id && c.types > 0).sort((a, b) => a.sortOrder - b.sortOrder)
  const isLeaf = (id: string) => children(id).length === 0
  const ancestors = (id: string) => {
    const out: Category[] = []
    for (let c = byId.get(id); c?.parentId; c = byId.get(c.parentId)) out.unshift(byId.get(c.parentId)!)
    return out
  }
  const leaves = (id: string | null): Category[] =>
    id && isLeaf(id) ? [byId.get(id)!] : children(id).flatMap((c) => leaves(c.id))
  return { all, byId, children, isLeaf, ancestors, leaves }
}

/** Histogram bins for several categories at once: id -> bins, earliest first. */
export async function getBins(db: D1Database, ids: string[], width: 10 | 25): Promise<Map<string, Bin[]>> {
  const out = new Map<string, Bin[]>(ids.map((id) => [id, []]))
  if (!ids.length) return out
  const { results } = await db
    .prepare(`SELECT category_id AS id, bin_start AS start, n FROM category_bin
              WHERE width = ? AND category_id IN (${ids.map(() => "?").join(",")}) ORDER BY bin_start`)
    .bind(width, ...ids)
    .all<{ id: string; start: number; n: number }>()
  for (const r of results) out.get(r.id)!.push({ start: r.start, n: r.n })
  return out
}

const PERSON_SELECT = `
  SELECT cp.category_id AS cat, p.id, p.name, cp.n, cp.start_year AS start, cp.end_year AS "end",
    cp.dated_by AS datedBy, ${IMAGE_COLS}
  FROM category_person cp JOIN person p ON p.id = cp.person_id
  LEFT JOIN image i ON i.id = cp.image_id`

const MINT_SELECT = `
  SELECT cm.category_id AS cat, m.id, m.name, cm.n, cm.start_year AS start, cm.end_year AS "end",
    r.name AS region, ${IMAGE_COLS}
  FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
  LEFT JOIN region r ON r.id = m.region_id
  LEFT JOIN image i ON i.id = cm.image_id`

type PersonRow = Omit<PersonCard, "photo"> & ImageCols & { cat: string }
type MintRow = Omit<MintCard, "photo"> & ImageCols & { cat: string }
const toPerson = ({ url, thumb, iiif: s, cat: _c, ...r }: PersonRow): PersonCard => ({ ...r, photo: photo({ url, thumb, iiif: s }) })
const toMint = ({ url, thumb, iiif: s, cat: _c, ...r }: MintRow): MintCard => ({ ...r, photo: photo({ url, thumb, iiif: s }) })

/** Top people (by types) for several categories: id -> people, most types first. */
export async function getTopPeople(db: D1Database, ids: string[], limit: number): Promise<Map<string, PersonCard[]>> {
  const out = new Map<string, PersonCard[]>(ids.map((id) => [id, []]))
  if (!ids.length) return out
  const { results } = await db
    .prepare(`${PERSON_SELECT} WHERE cp.rank <= ? AND cp.category_id IN (${ids.map(() => "?").join(",")}) ORDER BY cp.rank`)
    .bind(limit, ...ids)
    .all<PersonRow>()
  for (const r of results) out.get(r.cat)!.push(toPerson(r))
  return out
}

/** Top mints (by types) for several categories: id -> mints, most types first. */
export async function getTopMints(db: D1Database, ids: string[], limit: number): Promise<Map<string, MintCard[]>> {
  const out = new Map<string, MintCard[]>(ids.map((id) => [id, []]))
  if (!ids.length) return out
  const { results } = await db
    .prepare(`${MINT_SELECT} WHERE cm.rank <= ? AND cm.category_id IN (${ids.map(() => "?").join(",")}) ORDER BY cm.rank`)
    .bind(limit, ...ids)
    .all<MintRow>()
  for (const r of results) out.get(r.cat)!.push(toMint(r))
  return out
}

/** Earliest first; undated last, keeping the given order. */
export function chronological<T extends { start: number | null }>(list: T[]): T[] {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.start ?? Infinity) - (b.x.start ?? Infinity) || a.i - b.i)
    .map(({ x }) => x)
}

/* ---------------------------------------------------------------- one collection's page */

export type MapMint = { id: string; name: string; n: number; lon: number; lat: number; start: number | null; end: number | null; region: string | null }
export type RegionRow = { id: string; name: string; n: number; mints: { id: string; name: string; n: number }[] }
export type RegionGroup = { id: string; name: string; n: number; regions: RegionRow[] }

export type CategoryPage = {
  category: Category
  ancestors: Category[]
  variant: "parent" | "rulers" | "mints"
  children: Category[]
  /** Parent pages: each child's histogram (25-year bins) and cards. */
  childBins: Map<string, Bin[]>
  childPeople: Map<string, PersonCard[]>
  childMints: Map<string, MintCard[]>
  /** Leaf pages. */
  bins: Bin[]
  people: PersonCard[]
  mints: MintCard[]
  mapMints: MapMint[]
  regionGroups: RegionGroup[]
  denominations: Facet[]
  subjects: Facet[]
  materials: Facet[]
}

const FACETS = 8

export async function getCategoryPage(db: D1Database, id: string): Promise<CategoryPage | null> {
  const t = tree(await getCategories(db))
  const category = t.byId.get(id)
  if (!category || category.types === 0) return null
  const ancestors = t.ancestors(id)
  const children = t.children(id)

  if (children.length) {
    const ids = children.map((c) => c.id)
    const [childBins, childPeople, childMints] = await Promise.all([
      getBins(db, ids, 25),
      getTopPeople(db, ids, 12),
      getTopMints(db, ids.filter((c) => BY_MINT.has(c)), 12),
    ])
    return {
      category, ancestors, variant: "parent", children, childBins, childPeople, childMints,
      bins: [], people: [], mints: [], mapMints: [], regionGroups: [], denominations: [], subjects: [], materials: [],
    }
  }

  const byMint = BY_MINT.has(id)
  const facet = (kind: string, table: string) =>
    db.prepare(`SELECT x.id, x.name, f.n FROM category_facet f JOIN ${table} x ON x.id = f.entity_id
                WHERE f.category_id = ?1 AND f.kind = '${kind}' ORDER BY f.n DESC, x.name`).bind(id)
  const [bins, people, mints, map, denominations, subjects, materials] = await db.batch([
    db.prepare(`SELECT bin_start AS start, n FROM category_bin WHERE category_id = ?1 AND width = 10 ORDER BY bin_start`).bind(id),
    db.prepare(`${PERSON_SELECT} WHERE cp.category_id = ?1 AND cp.rank <= 12 ORDER BY cp.rank`).bind(id),
    db.prepare(`${MINT_SELECT} WHERE cm.category_id = ?1 AND cm.rank <= 12 ORDER BY cm.rank`).bind(id),
    // Every mint, for the map and (city coinage) the region index. Coordinates are the city's.
    db.prepare(`SELECT m.id, m.name, cm.n, m.lon, m.lat, cm.start_year AS start, cm.end_year AS "end",
                  r.id AS regionId, r.name AS region, g.id AS groupId, g.name AS groupName
                FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                LEFT JOIN region r ON r.id = m.region_id
                LEFT JOIN region_group g ON g.id = r.group_id
                WHERE cm.category_id = ?1
                ORDER BY g.sort_order IS NULL, g.sort_order, r.sort_order, cm.n DESC, m.name`).bind(id),
    facet("denomination", "denomination"),
    facet("subject", "subject"),
    facet("material", "material"),
  ])

  type MapRow = Omit<MapMint, "lon" | "lat"> & { lon: number | null; lat: number | null; regionId: string | null; groupId: string | null; groupName: string | null }
  const mapRows = map.results as MapRow[]
  const mapMints = mapRows
    .filter((m): m is MapRow & { lon: number; lat: number } => m.lon != null && m.lat != null)
    .map(({ id, name, n, lon, lat, start, end, region }) => ({ id, name, n, lon, lat, start, end, region }))
    .sort((a, b) => b.n - a.n)

  // Region index: headings in catalogue order, regions in catalogue order, mints by output.
  const groups = new Map<string, RegionGroup>()
  if (byMint) {
    for (const m of mapRows) {
      if (!m.groupId || !m.regionId) continue
      let g = groups.get(m.groupId)
      if (!g) groups.set(m.groupId, (g = { id: m.groupId, name: m.groupName!, n: 0, regions: [] }))
      let r = g.regions.find((x) => x.id === m.regionId)
      if (!r) g.regions.push((r = { id: m.regionId, name: m.region!, n: 0, mints: [] }))
      r.mints.push({ id: m.id, name: m.name, n: m.n })
      r.n += m.n
      g.n += m.n
    }
  }

  return {
    category, ancestors, variant: byMint ? "mints" : "rulers", children: [],
    childBins: new Map(), childPeople: new Map(), childMints: new Map(),
    bins: bins.results as Bin[],
    people: (people.results as PersonRow[]).map(toPerson),
    mints: (mints.results as MintRow[]).map(toMint),
    mapMints,
    regionGroups: [...groups.values()],
    denominations: (denominations.results as Facet[]).slice(0, FACETS),
    subjects: (subjects.results as Facet[]).slice(0, FACETS),
    materials: materials.results as Facet[],
  }
}

/* ---------------------------------------------------------------- people in a collection */

export type RulerSort = "reign" | "types" | "name"
export type RulerRow = { id: string; name: string; n: number; start: number | null; end: number | null; datedBy: string | null }

/**
 * Everyone who issued coins in a collection (or in all collections), for /rulers. A type sits in
 * one primary category, so summing a person's top-level counts never counts a type twice.
 */
export async function getRulers(db: D1Database, categoryId: string | null, sort: RulerSort): Promise<RulerRow[]> {
  const order = {
    reign: `start IS NULL, start, "end", n DESC, name`,
    types: `n DESC, name`,
    name: `name COLLATE NOCASE`,
  }[sort]
  const sql = categoryId
    ? `SELECT p.id, p.name, cp.n, cp.start_year AS start, cp.end_year AS "end", cp.dated_by AS datedBy
       FROM category_person cp JOIN person p ON p.id = cp.person_id WHERE cp.category_id = ?1`
    : `SELECT p.id, p.name, sum(cp.n) AS n, min(cp.start_year) AS start, max(cp.end_year) AS "end",
         CASE WHEN p.start_year IS NOT NULL THEN 'reign' WHEN min(cp.start_year) IS NOT NULL THEN 'coins' END AS datedBy
       FROM category_person cp JOIN person p ON p.id = cp.person_id
       JOIN category c ON c.id = cp.category_id AND c.parent_id IS NULL
       WHERE ?1 IS NULL GROUP BY p.id`
  const { results } = await db.prepare(`SELECT * FROM (${sql}) ORDER BY ${order}`).bind(categoryId).all<RulerRow>()
  return results
}

/* ---------------------------------------------------------------- collections as cards */

export type CollectionCard = { href: string; name: string; line: string; photo: Photo | null }
export type CollectionPreview = {
  /** Up to four cards: its main rulers or mints with photos, or its own collections. */
  cards: CollectionCard[]
  /** The photo that stands for it in lists. */
  photo: Photo | null
  more: { href: string; count: number; label: string }
}

/**
 * Cards for showing collections side by side (a parent's page, /collections): each one's main
 * rulers (kingdoms, emperors), main mints (city coinage) or sub-collections, photographed ones
 * first. Reads only the top rows of category_person / category_mint.
 */
export async function getPreviews(db: D1Database, t: Tree, cats: Category[]): Promise<Map<string, CollectionPreview>> {
  // Every leaf under these collections supplies photos.
  const leafIds = [...new Set(cats.flatMap((c) => t.leaves(c.id).map((l) => l.id)))]
  const [people, mints] = await Promise.all([
    getTopPeople(db, leafIds.filter((id) => !BY_MINT.has(id)), 12),
    getTopMints(db, leafIds.filter((id) => BY_MINT.has(id)), 12),
  ])
  const leafCards = (id: string): CollectionCard[] =>
    BY_MINT.has(id)
      ? (mints.get(id) ?? []).map((m) => ({ href: `/mint/${m.id}?collection=${id}`, name: m.name, line: metaLine(m.start, m.end, m.n), photo: m.photo }))
      : chronological(people.get(id) ?? []).map((p) => ({ href: `/ruler/${p.id}`, name: p.name, line: metaLine(p.start, p.end, p.n), photo: p.photo }))
  // The photo for a collection: its most prolific ruler's or mint's.
  const leafPhoto = (id: string): Photo | null =>
    (BY_MINT.has(id) ? mints.get(id) : people.get(id))?.find((x) => x.photo)?.photo ?? null
  const photoOf = (id: string): Photo | null =>
    t.isLeaf(id) ? leafPhoto(id) : t.leaves(id).map((l) => leafPhoto(l.id)).find(Boolean) ?? null

  const out = new Map<string, CollectionPreview>()
  for (const c of cats) {
    if (!t.isLeaf(c.id)) {
      const kids = t.children(c.id)
      out.set(c.id, {
        cards: kids.slice(0, 4).map((k) => ({ href: `/category/${k.id}`, name: k.name, line: metaLine(k.start, k.end, k.types), photo: photoOf(k.id) })),
        photo: photoOf(c.id),
        more: { href: `/category/${c.id}`, count: kids.length, label: kids.length === 1 ? "Collection" : "Collections" },
      })
      continue
    }
    const all = leafCards(c.id)
    const pictured = all.filter((x) => x.photo)
    const cards = [...pictured, ...all.filter((x) => !x.photo)].slice(0, 4)
    const byMint = BY_MINT.has(c.id)
    out.set(c.id, {
      // Keep the cards in date order after choosing them.
      cards: byMint ? cards : all.filter((x) => cards.includes(x)),
      photo: leafPhoto(c.id),
      more: byMint
        ? { href: `/mints?collection=${c.id}`, count: c.mints, label: "All mints" }
        : { href: `/rulers?collection=${c.id}`, count: c.people, label: `All ${peopleNoun(c.id).many}` },
    })
  }
  return out
}
