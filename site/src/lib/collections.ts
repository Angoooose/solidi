/*
 * Data for the Collections menu in the header: the collector
 * categories as a tree with type counts, and for each one a few cards to open: its main rulers
 * (kingdoms, emperors), its main mints (city coinages), or its sub-collections (Greek, Roman…).
 *
 * Read from the pipeline's summary tables (lib/categories.ts), a few hundred rows in all, and
 * served from /api/collections.json.
 */
import {
  BY_MINT, cardWorthy, chronological, getCategories, getTopMints, getTopPeople, metaLine, peopleNoun, tree, typesLabel,
  type Category, type Photo,
} from "@/lib/categories"

const CARDS = 12

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
  /** "All collections": every type, every leaf collection as a card. */
  all: { count: number; meta: string; cards: MenuCard[]; links: MenuLink[] }
  /** Depth-first, in sort order: the rail reads straight down. */
  collections: MenuCollection[]
}

const thumb = (p: Photo | null) => p?.thumb ?? null

export async function getCollectionsMenu(db: D1Database): Promise<CollectionsMenu> {
  const t = tree(await getCategories(db))
  const tops = t.children(null)
  const leafIds = t.leaves(null).map((c) => c.id)
  const topIds = tops.map((c) => c.id).map((id) => `'${id.replace(/'/g, "''")}'`).join(",")
  const [people, mints, overall] = await Promise.all([
    getTopPeople(db, leafIds.filter((id) => !BY_MINT.has(id)), CARDS),
    getTopMints(db, leafIds.filter((id) => BY_MINT.has(id)), CARDS),
    // Distinct over the top-level collections: a ruler or mint can appear under both Greek and Roman.
    db
      .prepare(`SELECT
          (SELECT count(DISTINCT person_id) FROM category_person WHERE category_id IN (${topIds})) AS people,
          (SELECT count(DISTINCT mint_id) FROM category_mint WHERE category_id IN (${topIds})) AS mints,
          (SELECT count(DISTINCT entity_id) FROM category_facet WHERE kind = 'denomination' AND category_id IN (${topIds})) AS denominations,
          (SELECT count(DISTINCT entity_id) FROM category_facet WHERE kind = 'subject' AND category_id IN (${topIds})) AS subjects`)
      .first<{ people: number; mints: number; denominations: number; subjects: number }>(),
  ])

  const leafCards = (c: Category): MenuCard[] => {
    if (BY_MINT.has(c.id)) {
      // Mints stay in order of output.
      return (mints.get(c.id) ?? []).map((m) => ({ name: m.name, href: `/mint/${m.id}?collection=${c.id}`, meta: metaLine(m.start, m.end, m.n), image: thumb(m.photo) }))
    }
    const min = Math.max(MIN_TYPES, c.types * MIN_SHARE)
    return chronological((people.get(c.id) ?? []).filter((p) => p.n >= min && cardWorthy(p))).map((p) => ({
      name: p.name, href: `/person/${p.id}`, meta: metaLine(p.start, p.end, p.n), image: thumb(p.photo),
    }))
  }
  const cardsOf = new Map<string, MenuCard[]>()
  const cardsFor = (c: Category): MenuCard[] => {
    if (!cardsOf.has(c.id)) cardsOf.set(c.id, t.isLeaf(c.id) ? leafCards(c) : t.children(c.id).map(collectionCard))
    return cardsOf.get(c.id)!
  }
  /* A category as a card, pictured by its first card with a photo. */
  function collectionCard(c: Category): MenuCard {
    return { name: c.name, href: `/category/${c.id}`, meta: metaLine(c.start, c.end, c.types), image: cardsFor(c).find((x) => x.image)?.image ?? null }
  }

  const links = (label: string, scope: string, n: { people: number; mints: number; denominations: number; subjects: number }): MenuLink[] =>
    [
      { label, href: `/people${scope}`, count: n.people },
      { label: "Mints", href: `/mints${scope}`, count: n.mints },
      { label: "Denominations", href: `/denominations${scope}`, count: n.denominations },
      { label: "Subjects", href: `/subjects${scope}`, count: n.subjects },
    ].filter((l) => l.count > 0)

  const collections: MenuCollection[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const c of t.children(parent)) {
      const p = c.parentId ? t.byId.get(c.parentId) : null
      const short = p && c.name.startsWith(p.name + " ") ? c.name.slice(p.name.length + 1) : c.name
      collections.push({
        id: c.id,
        name: c.name,
        shortName: short.charAt(0).toUpperCase() + short.slice(1),
        parentId: c.parentId,
        depth,
        count: c.types,
        meta: metaLine(c.start, c.end, c.types),
        cards: cardsFor(c),
        links: links(`All ${peopleNoun(c.id).many}`, `?collection=${c.id}`, c),
      })
      walk(c.id, depth + 1)
    }
  }
  walk(null, 0)

  const total = tops.reduce((n, c) => n + c.types, 0)
  const allCards = chronological(t.leaves(null).map((c) => ({ card: collectionCard(c), start: c.start }))).map((x) => x.card)
  return {
    all: {
      count: total,
      meta: `Oldest first · ${typesLabel(total)}`,
      cards: allCards,
      links: links("All people", "", overall ?? { people: 0, mints: 0, denominations: 0, subjects: 0 }),
    },
    collections,
  }
}
