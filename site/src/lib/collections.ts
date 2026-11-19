/*
 * Data for the Collections menu in the header: the collector
 * categories as a tree with type counts, and for each one a few cards to open: its main rulers
 * (kingdoms, emperors), its main mints (city coinages), or its sub-collections (Greek, Roman…).
 *
 * The data only changes with a new build of the database, so it is computed once per isolate and
 * served from /api/collections.json with a long cache.
 */
import { iiif, secure, yearRange } from "@/lib/format"
import { REFUSING_HOST } from "@/lib/typeCards"

/* Up to six rows of two: as tall as the rail, so every view fits the same panel. */
const CARDS = 12

/*
 * City coinages are indexed by mint: their "rulers" are magistrates and client kings with a handful
 * of types each. Every other category is indexed by its rulers.
 */
const BY_MINT = new Set(["archaic-classical", "hellenistic-cities", "roman-provincial"])

/* What "All people" is called inside a category. */
const PEOPLE_LABEL: Record<string, string> = { "roman-imperial": "All emperors" }

/* Person records that stand for no one: unsigned Republican issues. */
const NOT_PEOPLE = `'anonymous'`

/*
 * A ruler earns a card with at least this share of the category's types (and at least 5): it keeps
 * out governors and one-off issuers (Nikokles of Paphos in Macedonian Kings) without hiding the
 * small kingdoms' kings.
 */
const MIN_SHARE = 0.005
const MIN_TYPES = 5

export type MenuCard = {
  name: string
  href: string
  /** "305–281 BC · 336 types" */
  meta: string
  image: string | null
}

export type MenuLink = { label: string; href: string; count: number }

export type MenuCollection = {
  id: string
  name: string
  /** The name under its parent in the rail: "Imperial" under Roman. */
  shortName: string
  parentId: string | null
  depth: number
  count: number
  /** "320–46 BC · 2,555 types" */
  meta: string
  cards: MenuCard[]
  links: MenuLink[]
}

export type CollectionsMenu = {
  /** "All collections": every type, its top-level collections' leaves as cards. */
  all: { count: number; meta: string; cards: MenuCard[]; links: MenuLink[] }
  /** Depth-first, in sort order: the rail reads straight down. */
  collections: MenuCollection[]
}

/* Live types only: replaced types and sub-variants would count some rulers twice (Hadrian). */
const LIVE = `
  live AS (
    SELECT t.id, t.mint_id, t.start_year AS s, coalesce(t.end_year, t.start_year) AS e, tc.category_id AS cat
    FROM coin_type t JOIN type_category tc ON tc.type_id = t.id AND tc.is_primary = 1
    WHERE t.replaced_by_id IS NULL AND t.parent_id IS NULL
  )`

/* Every category paired with itself and each descendant, for counts that roll up. */
const DESCENDANTS = `
  d(root, id) AS (
    SELECT id, id FROM category
    UNION ALL SELECT d.root, c.id FROM category c JOIN d ON c.parent_id = d.id
  )`

/*
 * A photo's id, preferring one with a small thumbnail; `where` narrows specimen_type st / image i.
 * Kenom's IIIF images come last: browsers block them (ORB) after Kenom's redirect.
 */
const PHOTO = (where: string) => `
  (SELECT i.id FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
   WHERE ${where} AND i.url NOT LIKE ${REFUSING_HOST}
   ORDER BY i.url LIKE '%kenom.de%', i.thumbnail_url IS NULL, i.iiif_service IS NULL LIMIT 1)`

/* The types of person r.id in category r.cat with one of these roles. */
const THEIR_TYPES = (roles: string) => `
  SELECT tp.type_id FROM type_person tp JOIN type_category tc ON tc.type_id = tp.type_id AND tc.category_id = r.cat
  WHERE tp.person_id = r.id AND tp.role IN (${roles})`

type CategoryRow = { id: string; parent_id: string | null; name: string; sort_order: number; n: number; s: number | null; e: number | null }
type EntityRow = { root: string; kind: "people" | "mints" | "denominations" | "subjects"; n: number }
type CardRow = { cat: string; id: string; name: string; s: number | null; e: number | null; n: number; url: string | null; thumb: string | null; iiif: string | null }

const fmt = (n: number) => n.toLocaleString("en-GB")
const types = (n: number) => `${fmt(n)} ${n === 1 ? "type" : "types"}`
const meta = (s: number | null, e: number | null, n: number) => [yearRange(s, e), types(n)].filter(Boolean).join(" · ")
/* Thumbnails are static ~175px files: faster than asking a IIIF server to scale. */
const photo = (r: { url: string | null; thumb: string | null; iiif: string | null }) => secure(r.thumb) ?? iiif(r.iiif, 160) ?? secure(r.url)

async function load(db: D1Database): Promise<CollectionsMenu> {
  const [categories, entities, people, mints] = await db.batch([
    db.prepare(`WITH RECURSIVE ${DESCENDANTS}, ${LIVE}
      SELECT c.id, c.parent_id, c.name, c.sort_order, count(l.id) AS n, min(l.s) AS s, max(l.e) AS e
      FROM category c JOIN d ON d.root = c.id LEFT JOIN live l ON l.cat = d.id
      GROUP BY c.id`),
    // Distinct people, mints (workshops folded into their city), denominations and subjects per
    // category with its descendants, and over everything (root '').
    db.prepare(`WITH RECURSIVE ${DESCENDANTS}, ${LIVE},
      ents AS (
        SELECT l.cat, 'people' AS kind, tp.person_id AS e FROM live l
          JOIN type_person tp ON tp.type_id = l.id AND tp.role IN ('authority', 'issuer')
        UNION SELECT l.cat, 'mints', coalesce(m.parent_id, m.id) FROM live l JOIN mint m ON m.id = l.mint_id
        UNION SELECT l.cat, 'denominations', td.denomination_id FROM live l JOIN type_denomination td ON td.type_id = l.id
        UNION SELECT l.cat, 'subjects', ts.subject_id FROM live l JOIN type_subject ts ON ts.type_id = l.id
      )
      SELECT d.root, e.kind, count(DISTINCT e.e) AS n FROM d JOIN ents e ON e.cat = d.id GROUP BY 1, 2
      UNION ALL SELECT '', kind, count(DISTINCT e) FROM ents GROUP BY kind`),
    // Each category's rulers by number of types they issued, with an obverse portrait from it.
    db.prepare(`WITH ${LIVE},
      pc AS (
        SELECT l.cat, tp.person_id AS id, count(DISTINCT l.id) AS n FROM live l
        JOIN type_person tp ON tp.type_id = l.id AND tp.role IN ('authority', 'issuer')
        WHERE tp.person_id NOT IN (${NOT_PEOPLE})
        GROUP BY 1, 2
      ),
      ranked AS (SELECT *, row_number() OVER (PARTITION BY cat ORDER BY n DESC, id) AS rk FROM pc),
      top AS (
        SELECT r.cat, p.id, p.name, p.start_year AS s, p.end_year AS e, r.n,
          -- Their portrait, else any obverse of theirs (Alexander's show Herakles, not him).
          coalesce(${PHOTO(`i.side = 'obverse' AND st.type_id IN (${THEIR_TYPES("'portrait_obverse'")})`)},
                   ${PHOTO(`i.side = 'obverse' AND st.type_id IN (${THEIR_TYPES("'authority', 'issuer'")})`)}) AS image_id
        FROM ranked r JOIN person p ON p.id = r.id WHERE r.rk <= ${CARDS} AND r.n >= ${MIN_TYPES}
      )
      SELECT top.*, i.url, i.thumbnail_url AS thumb, i.iiif_service AS iiif FROM top LEFT JOIN image i ON i.id = top.image_id`),
    // Each city-coinage category's mints by number of types, with an obverse from it.
    db.prepare(`WITH ${LIVE},
      mc AS (
        SELECT l.cat, coalesce(m.parent_id, m.id) AS id, count(*) AS n, min(l.s) AS s, max(l.e) AS e
        FROM live l JOIN mint m ON m.id = l.mint_id
        WHERE l.cat IN (${[...BY_MINT].map((c) => `'${c}'`).join(", ")})
        GROUP BY 1, 2
      ),
      ranked AS (SELECT *, row_number() OVER (PARTITION BY cat ORDER BY n DESC, id) AS rk FROM mc),
      top AS (
        SELECT r.cat, r.id, m.name, r.s, r.e, r.n,
          ${PHOTO(`i.side = 'obverse' AND st.type_id IN (
            SELECT l.id FROM live l JOIN mint wm ON wm.id = l.mint_id
            WHERE l.cat = r.cat AND coalesce(wm.parent_id, wm.id) = r.id)`)} AS image_id
        FROM ranked r JOIN mint m ON m.id = r.id WHERE r.rk <= ${CARDS}
      )
      SELECT top.*, i.url, i.thumbnail_url AS thumb, i.iiif_service AS iiif FROM top LEFT JOIN image i ON i.id = top.image_id`),
  ])

  const cats = categories.results as CategoryRow[]
  const byId = new Map(cats.map((c) => [c.id, c]))

  const counts = new Map<string, Partial<Record<EntityRow["kind"], number>>>()
  for (const r of entities.results as EntityRow[]) counts.set(r.root, { ...counts.get(r.root), [r.kind]: r.n })

  const group = (rows: CardRow[]) => {
    const out = new Map<string, CardRow[]>()
    for (const r of rows) out.set(r.cat, [...(out.get(r.cat) ?? []), r])
    return out
  }
  const peopleBy = group(people.results as CardRow[])
  const mintsBy = group(mints.results as CardRow[])

  const children = (parent: string | null) =>
    cats.filter((c) => c.parent_id === parent && c.n > 0).sort((a, b) => a.sort_order - b.sort_order)
  const isLeaf = (id: string) => children(id).length === 0

  /* Cards keep their start year until they are sorted: earliest first, undated last in count order. */
  type Dated = MenuCard & { start: number | null }
  const earliestFirst = (list: Dated[]): MenuCard[] =>
    list
      .map((card, i) => ({ card, i }))
      .sort((a, b) => (a.card.start ?? Infinity) - (b.card.start ?? Infinity) || a.i - b.i)
      .map(({ card: { start: _start, ...card } }) => card)

  /* Cards for a category: its rulers or mints; a parent gets its children. */
  const cards = new Map<string, MenuCard[]>()
  const cardsFor = (c: CategoryRow): MenuCard[] => {
    if (!cards.has(c.id)) {
      const min = Math.max(MIN_TYPES, c.n * MIN_SHARE)
      const list: Dated[] = !isLeaf(c.id)
        ? children(c.id).map(collectionCard)
        : BY_MINT.has(c.id)
          ? (mintsBy.get(c.id) ?? []).map((m) => ({
              name: m.name,
              href: `/mint/${m.id}?collection=${c.id}`,
              meta: meta(m.s, m.e, m.n),
              image: photo(m),
              start: null, // mints stay in order of output
            }))
          : (peopleBy.get(c.id) ?? [])
              .filter((p) => p.n >= min)
              .map((p) => ({ name: p.name, href: `/ruler/${p.id}`, meta: meta(p.s, p.e, p.n), image: photo(p), start: p.s }))
      cards.set(c.id, earliestFirst(list))
    }
    return cards.get(c.id)!
  }

  /* A category as a card (in its parent's view or "All collections"), pictured by its first card with a photo. */
  function collectionCard(c: CategoryRow): Dated {
    return { name: c.name, href: `/category/${c.id}`, meta: meta(c.s, c.e, c.n), image: cardsFor(c).find((x) => x.image)?.image ?? null, start: c.s }
  }

  const links = (root: string, peopleLabel: string, scope: string): MenuLink[] => {
    const n = counts.get(root) ?? {}
    return [
      { label: peopleLabel, href: `/rulers${scope}`, count: n.people ?? 0 },
      { label: "Mints", href: `/mints${scope}`, count: n.mints ?? 0 },
      { label: "Denominations", href: `/denominations${scope}`, count: n.denominations ?? 0 },
      { label: "Subjects", href: `/subjects${scope}`, count: n.subjects ?? 0 },
    ].filter((l) => l.count > 0)
  }

  const collections: MenuCollection[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const c of children(parent)) {
      const p = c.parent_id ? byId.get(c.parent_id) : null
      const shortName = p && c.name.startsWith(p.name + " ") ? c.name.slice(p.name.length + 1) : c.name
      collections.push({
        id: c.id,
        name: c.name,
        shortName: shortName.charAt(0).toUpperCase() + shortName.slice(1),
        parentId: c.parent_id,
        depth,
        count: c.n,
        meta: meta(c.s, c.e, c.n),
        cards: cardsFor(c),
        links: links(c.id, PEOPLE_LABEL[c.id] ?? "All rulers", `?collection=${c.id}`),
      })
      walk(c.id, depth + 1)
    }
  }
  walk(null, 0)

  /* "All collections" shows the named collections people browse by: every leaf, earliest first. */
  const leaves = cats.filter((c) => c.n > 0 && isLeaf(c.id))
  const allCards = earliestFirst(leaves.map(collectionCard))
  const total = children(null).reduce((sum, c) => sum + c.n, 0)

  return {
    all: { count: total, meta: `Oldest first · ${types(total)}`, cards: allCards, links: links("", "All people", "") },
    collections,
  }
}

let cached: Promise<CollectionsMenu> | null = null

/** The menu's data, computed once per isolate; a failed load is retried on the next call. */
export function getCollectionsMenu(db: D1Database): Promise<CollectionsMenu> {
  cached ??= load(db).catch((err) => {
    cached = null
    throw err
  })
  return cached
}
