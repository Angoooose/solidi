/*
 * Data for the subject page (/subject/zeus): what it was (Wikipedia,
 * else Nomisma's definition), which side of the coin it's on, its Greek or Roman counterpart,
 * where and when it was struck (category_subject), who issued it, its denominations, mints and
 * the legends naming it (subject_legend), then its coinage with filters (lib/coinage.ts).
 */
import { getCategories, photo, tree, IMAGE_COLS, type Category, type Photo } from "@/lib/categories"
import { COLLECTION, DENOMINATION, ISSUER, PHOTO, cards, coinage, parseCommon, photoToggle, type Facet, type Filter, type PhotoToggle, type Sort } from "@/lib/coinage"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"
import { lead } from "@/lib/format"
import { subjectGroup, type SubjectGroup } from "@/lib/subjects"

const NOT_PEOPLE = `('anonymous')`
/** A normalised Latin legend, as subject_legend stores it: 'VICTORIA AVGG'. */
const LEGEND = /^[A-Z0-9 ]{1,120}$/

export type SubjectQuery = {
  collection: string | null
  issuer: string | null
  denomination: string | null
  side: string | null
  legend: string | null
  sort: Sort
  limit: number
  /** "1": only types with a photograph. */
  photo: string | null
}

export function parseQuery(params: URLSearchParams): SubjectQuery {
  const { slug, photo, sort, limit } = parseCommon(params)
  const side = params.get("side")
  const legend = params.get("legend")
  return {
    collection: slug("collection"),
    issuer: slug("issuer"),
    denomination: slug("denomination"),
    side: side === "obverse" || side === "reverse" ? side : null,
    legend: legend && LEGEND.test(legend) ? legend : null,
    photo,
    sort,
    limit,
  }
}

export type SubjectCollection = { category: Category; n: number; start: number | null; end: number | null; bins: Bin[] }

export type Subject = {
  id: string
  name: string
  lead: string | null
  article: { url: string; licence: string } | null
  /** Its heading on /subjects; null for one that isn't listed. */
  group: { id: SubjectGroup; name: string } | null
  types: number
  obverse: number
  reverse: number
  greek: number
  roman: number
  /** Its counterpart in the other half of the collections: Zeus's Jupiter. */
  pair: { id: string; name: string; types: number; roman: boolean } | null
  start: number | null
  end: number | null
  specimens: number
  holders: number
  photo: Photo | null
  /** Leaf collections it was struck in, earliest first. */
  collections: SubjectCollection[]
  people: { items: Facet[]; total: number }
  denominations: { items: Facet[]; total: number }
  mints: { items: Facet[]; total: number }
  legends: Facet[]
  available: { collection: boolean; issuer: boolean; denomination: boolean; side: boolean }
  collectionFacet: Facet[]
  issuerFacet: Facet[]
  denominationFacet: Facet[]
  sideFacet: Facet[]
  /** The "Photographed" toggle. */
  photographed: PhotoToggle
  total: number
  grid: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

/* Every live type showing the subject (?1). */
const BASE = `t.replaced_by_id IS NULL AND t.parent_id IS NULL AND t.id IN (SELECT type_id FROM type_subject WHERE subject_id = ?1)`
/* The side it's on, and a legend on that side (from "Named in legends"). */
const SIDE: Filter = { name: "side", match: (v) => `t.id IN (SELECT type_id FROM type_subject WHERE subject_id = ?1 AND side = ${v})` }
const LEGEND_FILTER: Filter = {
  name: "legend",
  match: (v) => `t.id IN (SELECT g.type_id FROM legend g JOIN type_subject ts ON ts.type_id = g.type_id AND ts.side = g.side AND ts.subject_id = ?1 WHERE g.normalised = ${v})`,
}
const FILTERS = [COLLECTION, ISSUER, DENOMINATION, SIDE, LEGEND_FILTER, PHOTO]

export async function getSubject(db: D1Database, id: string, query: SubjectQuery): Promise<Subject | null> {
  const s = await db
    .prepare(`SELECT s.id, s.name, s.definition, x.grp, x.types, x.obverse, x.reverse, x.greek, x.roman, x.start_year AS start,
                x.end_year AS "end", x.specimens, x.holders, x.people, x.mints, x.denominations,
                p.id AS pairId, p.name AS pairName, px.types AS pairTypes, px.roman > px.greek AS pairRoman, ${IMAGE_COLS}
              FROM subject s JOIN subject_stat x ON x.subject_id = s.id
              LEFT JOIN subject p ON p.id = x.pair_id LEFT JOIN subject_stat px ON px.subject_id = x.pair_id
              LEFT JOIN image i ON i.id = x.image_id
              WHERE s.id = ?`)
    .bind(id)
    .first<{
      id: string; name: string; definition: string | null; grp: SubjectGroup; types: number; obverse: number; reverse: number
      greek: number; roman: number; start: number | null; end: number | null; specimens: number; holders: number
      people: number; mints: number; denominations: number
      pairId: string | null; pairName: string | null; pairTypes: number | null; pairRoman: number | null
      url: string | null; thumb: string | null; iiif: string | null
    }>()
  if (!s) return null

  const t = tree(await getCategories(db))
  const c = coinage(db, id, BASE, FILTERS, [query.collection, query.issuer, query.denomination, query.side, query.legend, query.photo])
  const { one } = c

  const [article, perCollection, people, denominations, mints, legends, collectionFacet, issuerFacet, denominationFacet, sideFacet, total, photoRows, types] =
    await db.batch([
      one(`SELECT extract, url, licence FROM article WHERE entity_type = 'subject' AND entity_id = ?1
           ORDER BY source = 'wikipedia_en' DESC LIMIT 1`),
      one(`SELECT category_id AS id, n, start_year AS start, end_year AS "end", bins FROM category_subject WHERE subject_id = ?1`),
      one(`SELECT p.id AS value, p.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_person tp ON tp.type_id = t.id AND tp.role IN ('authority', 'issuer') JOIN person p ON p.id = tp.person_id
           WHERE ${BASE} AND p.id NOT IN ${NOT_PEOPLE} GROUP BY p.id ORDER BY count DESC, p.name`),
      one(`SELECT d.id AS value, d.name AS label, count(DISTINCT t.id) AS count
           FROM coin_type t JOIN type_denomination td ON td.type_id = t.id JOIN denomination d ON d.id = td.denomination_id
           WHERE ${BASE} GROUP BY d.id ORDER BY count DESC, d.name`),
      one(`SELECT coalesce(pm.id, m.id) AS value, coalesce(pm.name, m.name) AS label, count(*) AS count
           FROM coin_type t JOIN mint m ON m.id = t.mint_id LEFT JOIN mint pm ON pm.id = m.parent_id
           WHERE ${BASE} GROUP BY value ORDER BY count DESC, label`),
      one(`SELECT legend AS value, legend AS label, n AS count FROM subject_legend WHERE subject_id = ?1 ORDER BY n DESC, legend`),
      c.collectionFacet(),
      c.issuerFacet(),
      c.denominationFacet(),
      c.grid(`SELECT ts.side AS value, upper(substr(ts.side, 1, 1)) || substr(ts.side, 2) AS label, count(DISTINCT t.id) AS count
              FROM coin_type t JOIN type_subject ts ON ts.type_id = t.id AND ts.subject_id = ?1
              WHERE ${c.where("side")} GROUP BY ts.side ORDER BY count DESC`),
      c.total(),
      c.photoFacet(),
      c.types(query.sort, query.limit),
    ])

  const rows = perCollection.results as { id: string; n: number; start: number | null; end: number | null; bins: string | null }[]
  const collections = rows
    .filter((r) => t.byId.has(r.id) && t.isLeaf(r.id))
    .map((r) => ({
      category: t.byId.get(r.id)!,
      n: r.n,
      start: r.start,
      end: r.end,
      bins: (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([start, n]) => ({ start, n })),
    }))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.n - a.n)

  const art = article.results[0] as { extract: string; url: string; licence: string } | undefined
  const all = (r: D1Result, total: number) => ({ items: r.results as Facet[], total })
  const grid = await cards(db, types)
  const group = subjectGroup(s.grp)

  return {
    id: s.id,
    name: s.name,
    lead: lead(art?.extract ?? s.definition, 420),
    article: art ? { url: art.url, licence: art.licence } : null,
    group: group ? { id: group.id, name: group.name } : null,
    types: s.types,
    obverse: s.obverse,
    reverse: s.reverse,
    greek: s.greek,
    roman: s.roman,
    pair: s.pairId ? { id: s.pairId, name: s.pairName!, types: s.pairTypes ?? 0, roman: !!s.pairRoman } : null,
    start: s.start,
    end: s.end,
    specimens: s.specimens,
    holders: s.holders,
    photo: photo(s),
    collections,
    people: all(people, s.people),
    denominations: all(denominations, s.denominations),
    mints: all(mints, s.mints),
    legends: legends.results as Facet[],
    available: { collection: collections.length > 1, issuer: s.people > 1, denomination: s.denominations > 1, side: s.obverse > 0 && s.reverse > 0 },
    collectionFacet: collectionFacet.results as Facet[],
    issuerFacet: issuerFacet.results as Facet[],
    denominationFacet: denominationFacet.results as Facet[],
    sideFacet: sideFacet.results as Facet[],
    photographed: photoToggle(photoRows),
    total: (total.results[0] as { n: number }).n,
    grid: grid.types,
    typeCredits: grid.typeCredits,
  }
}
