/*
 * Data for the subject page (/subject/zeus): what it was (Wikipedia,
 * else Nomisma's definition), which side of the coin it's on, its Greek or Roman counterpart,
 * where and when it was struck (category_subject), who issued it, its denominations, mints and
 * the legends naming it (subject_legend), computed when the database is built (lib/summary/),
 * then its coinage with filters (lib/coinage.ts).
 */
import { getCategories, photo, tree, IMAGE_COLS, type Category, type Photo } from "@/lib/categories"
import { COLLECTION, DENOMINATION, ISSUER, PHOTO, cards, coinage, collectionKeys, denominationKeys, find, issuerKeys, parseCommon, ranked, sideKeys, sideLabels, some, subjectBase, type Facet, type Filter, type PhotoToggle, type Sort } from "@/lib/coinage"
import { SIDES, type FacetIndex } from "@/lib/facet"
import { facetIndex } from "@/lib/facet/store"
import { sections } from "@/lib/summary/store"
import type { PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import type { Bin } from "@/components/charts"
import { lead } from "@/lib/format"
import { subjectGroup, type SubjectGroup } from "@/lib/subjects"

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

/* The side it's on, and a legend on that side (from "Named in legends"), for subject `s`. */
const side = (s: number): Filter => ({
  name: "side",
  keep: (ix, v) => {
    const side = SIDES.indexOf(v as (typeof SIDES)[number])
    return side < 0 ? () => false : (t) => some(ix.subject, t, (x) => x === s * 2 + side)
  },
})
const legend = (s: number): Filter => ({
  name: "legend",
  keep: (ix: FacetIndex, v) => {
    const g = ix.legends.indexOf(v)
    return g < 0 ? () => false : (t) => some(ix.legend, t, (x) => x >> 1 === g && some(ix.subject, t, (y) => y === s * 2 + (x & 1)))
  },
})

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

  const [t, ix] = await Promise.all([getCategories(db).then(tree), facetIndex(db)])
  const si = find(ix.subjects, id)
  const c = coinage(ix, subjectBase(ix, id), [COLLECTION, ISSUER, DENOMINATION, side(si), legend(si), PHOTO], [
    query.collection, query.issuer, query.denomination, query.side, query.legend, query.photo,
  ])
  const [{ article, perCollection, people, denominations, mints, legends }, grid] = await Promise.all([
    sections(db, "subject", id),
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
      bins: (JSON.parse(r.bins ?? "[]") as [number, number][]).map(([start, n]) => ({ start, n })),
    }))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.n - a.n)

  const art = article[0] as (typeof article)[number] | undefined
  const all = (items: Facet[], total: number) => ({ items, total })
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
    legends,
    available: { collection: collections.length > 1, issuer: s.people > 1, denomination: s.denominations > 1, side: s.obverse > 0 && s.reverse > 0 },
    collectionFacet: c.facet("collection", collectionKeys(ix), ix.categories),
    issuerFacet: c.facet("issuer", issuerKeys(ix), ix.persons),
    denominationFacet: c.facet("denomination", denominationKeys(ix), ix.denominations),
    sideFacet: ranked(c.counts("side", sideKeys(ix, si)), sideLabels),
    photographed: c.photo(),
    total: c.total(),
    grid: grid.types,
    typeCredits: grid.typeCredits,
  }
}
