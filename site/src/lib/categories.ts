/*
 * Data for the collection pages (/collections, /category/[id], /people?collection=) and the
 * header's Collections menu. Everything is read from the summary tables the pipeline writes
 * (pipeline/summaries.py: category_stat, _bin, _facet, _person, _mint), so a page reads tens to
 * hundreds of rows, never the coin types themselves.
 */
import { iiif, secure, yearRange } from "@/lib/format"

/* City coinages are browsed by mint; their people are magistrates, governors and client kings. */
export const BY_MINT = new Set(["archaic-classical", "hellenistic-cities", "roman-provincial"])

/*
 * What a category's people are called ("All 40 kings and queens", "Filter moneyers"). The pages and
 * URLs say "people"; a collection names its own where one word fits them.
 */
const KINGS = { one: "king or queen", many: "kings and queens" }
const PEOPLE: Record<string, { one: string; many: string }> = {
  "roman-imperial": { one: "emperor", many: "emperors" },
  "roman-republican": { one: "moneyer", many: "moneyers" },
  "roman-imperatorial": { one: "issuer", many: "issuers" },
  "macedonian-kings": KINGS,
  antigonid: KINGS,
  seleucid: KINGS,
  ptolemaic: KINGS,
  "bactrian-indo-greek": KINGS,
  attalid: KINGS,
  "archaic-classical": { one: "magistrate or ruler", many: "magistrates and rulers" },
  "hellenistic-cities": { one: "magistrate or ruler", many: "magistrates and rulers" },
}
export function peopleNoun(categoryId: string | null) {
  return (categoryId && PEOPLE[categoryId]) || { one: "person", many: "people" }
}

export const fmt = (n: number) => Math.round(n).toLocaleString("en-GB")
export const typesLabel = (n: number) => `${fmt(n)} ${Math.round(n) === 1 ? "type" : "types"}`
/** "320–46 BC · 2,555 types" */
export const metaLine = (s: number | null, e: number | null, n: number) => [yearRange(s, e), typesLabel(n)].filter(Boolean).join(" · ")

export type Photo = { thumb: string | null; large: string | null }
export type ImageCols = { url: string | null; thumb: string | null; iiif: string | null }
/* thumb: small rows and menus (static ~175px files where the holder has them); large: cards. */
export function photo(r: ImageCols): Photo | null {
  if (!r.url && !r.iiif) return null
  return {
    thumb: secure(r.thumb) ?? iiif(r.iiif, 160) ?? secure(r.url),
    // ANS serves ready-made 350px files much faster than its IIIF server renders one.
    // Its "noscale" originals run to 2 MB; their thumbnail (a 600px copy at Corpus Nummorum) reads as well.
    large: r.url?.includes(".width350.")
      ? secure(r.url)
      : (iiif(r.iiif, 600) ?? (r.url?.includes(".noscale.") && r.thumb ? secure(r.thumb) : (secure(r.url) ?? secure(r.thumb)))),
  }
}
export const IMAGE_COLS = `i.url, i.thumbnail_url AS thumb, i.iiif_service AS iiif`

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

/** A category's name under its parent: "Imperial" under Roman, "Seleucid Kingdom" under Hellenistic. */
export function shortName(c: Category, parent: Category | null | undefined): string {
  const short = parent && c.name.startsWith(parent.name + " ") ? c.name.slice(parent.name.length + 1) : c.name
  return short.charAt(0).toUpperCase() + short.slice(1)
}

/**
 * The Collection select's options: "All collections", then the tree depth-first, each collection
 * indented under its parent by its short name. `count` is what the page counts (people, mints…);
 * collections with none are left out.
 */
export function collectionOptions(t: Tree, count: (c: Category) => number) {
  const out: { value: string; label: string; short?: string; depth?: number; count?: number }[] = [
    { value: "all", label: "All collections" },
  ]
  const walk = (parent: Category | null, depth: number) => {
    const kids = t.all.filter((c) => c.parentId === (parent?.id ?? null) && count(c) > 0).sort((a, b) => a.sortOrder - b.sortOrder)
    for (const c of kids) {
      out.push({ value: c.id, label: c.name, short: shortName(c, parent), depth, count: count(c) })
      walk(c, depth + 1)
    }
  }
  walk(null, 0)
  return out
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

/*
 * People worth a card: not issuers known only by a control mark ("P (Republican Moneyer)",
 * "Anchor 1 (Republican Moneyer)"); they stay in the lists.
 */
export const cardWorthy = (p: { name: string }) => !p.name.endsWith("(Republican Moneyer)")

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
  variant: "parent" | "people" | "mints"
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
    db.prepare(`${PERSON_SELECT} WHERE cp.category_id = ?1 AND cp.rank <= 24 ORDER BY cp.rank`).bind(id),
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
    category, ancestors, variant: byMint ? "mints" : "people", children: [],
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

export type PeopleSort = "date" | "types" | "name"
type Span = [number, number]
export type PeopleRow = {
  id: string
  name: string
  n: number
  /** In office: a reign, a magistracy, a year as moneyer. */
  office: Span | null
  /** Every year their coins in the collection may date to; can run past the office (posthumous, joint issues). */
  coins: Span | null
  /** Birth to death, where both are known. */
  lived: Span | null
}

/**
 * Everyone who issued coins in a collection (or in all collections), for /people. A type sits in
 * one primary category, so summing a person's top-level counts never counts a type twice.
 * Ordered by date: when they took office, else when their coins begin.
 */
export async function getPeople(db: D1Database, categoryId: string | null, sort: PeopleSort): Promise<PeopleRow[]> {
  const order = {
    date: `coalesce(os, cs) IS NULL, coalesce(os, cs), coalesce(oe, ce), n DESC, name`,
    types: `n DESC, name`,
    name: `name COLLATE NOCASE`,
  }[sort]
  const person = `p.id, p.name, p.start_year AS os, coalesce(p.end_year, p.start_year) AS oe,
    CASE WHEN p.death_year >= p.birth_year THEN p.birth_year END AS ls, CASE WHEN p.death_year >= p.birth_year THEN p.death_year END AS le`
  const sql = categoryId
    ? `SELECT ${person}, cp.n, cp.coins_start AS cs, cp.coins_end AS ce
       FROM category_person cp JOIN person p ON p.id = cp.person_id WHERE cp.category_id = ?1`
    : `SELECT ${person}, sum(cp.n) AS n, min(cp.coins_start) AS cs, max(cp.coins_end) AS ce
       FROM category_person cp JOIN person p ON p.id = cp.person_id
       JOIN category c ON c.id = cp.category_id AND c.parent_id IS NULL
       WHERE ?1 IS NULL GROUP BY p.id`
  type Raw = { id: string; name: string; n: number; os: number | null; oe: number | null; cs: number | null; ce: number | null; ls: number | null; le: number | null }
  const { results } = await db.prepare(`SELECT * FROM (${sql}) ORDER BY ${order}`).bind(categoryId).all<Raw>()
  const span = (s: number | null, e: number | null): Span | null => (s == null ? null : [Math.min(s, e ?? s), Math.max(s, e ?? s)])
  return results.map((r) => ({ id: r.id, name: r.name, n: r.n, office: span(r.os, r.oe), coins: span(r.cs, r.ce), lived: span(r.ls, r.le) }))
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
    getTopPeople(db, leafIds.filter((id) => !BY_MINT.has(id)), 24),
    getTopMints(db, leafIds.filter((id) => BY_MINT.has(id)), 12),
  ])
  const leafCards = (id: string): CollectionCard[] =>
    BY_MINT.has(id)
      ? (mints.get(id) ?? []).map((m) => ({ href: `/mint/${m.id}?collection=${id}`, name: m.name, line: metaLine(m.start, m.end, m.n), photo: m.photo }))
      : chronological((people.get(id) ?? []).filter(cardWorthy)).map((p) => ({ href: `/person/${p.id}`, name: p.name, line: metaLine(p.start, p.end, p.n), photo: p.photo }))
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
        : { href: `/people?collection=${c.id}`, count: c.people, label: `All ${peopleNoun(c.id).many}` },
    })
  }
  return out
}
