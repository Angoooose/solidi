/*
 * Data for the person page (/person/trajan): the person, every coin type connected to them (issued
 * by them or showing their portrait) with filters, and a strip of their portraits across the reign.
 * Filters come from the URL so every view is shareable.
 *
 * Portrait and issuer are separate filters, as the data models them: "coins of Plotina" are coins
 * with her portrait, struck by Trajan; Constantine issued thousands of coins for his sons.
 *
 * Coins struck in a ruler's name by others (role 'stated_authority' without 'authority': most
 * Alexanders were struck after his death, by his successors and by cities) are part of the ruler's
 * coinage but kept apart by the "Struck" filter.
 */
import { iiif, lead, secure, year, yearRange } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import type { TypeCardData } from "@/lib/typeCards"
import { DENOMINATION, ISSUER, PERIOD, PHOTO, cards, coinage, denominationKeys, find, inName, issuerKeys, parseCommon, personBase, portraitKeys, some, type Facet, type Filter, type PhotoToggle, type Sort } from "@/lib/coinage"
import { PORTRAIT } from "@/lib/facet"
import { facetIndex } from "@/lib/facet/store"
import { sections } from "@/lib/summary/store"

export { PAGE_SIZE } from "@/lib/coinage"
export type { Facet, Sort }
const PORTRAITS = 6
/** Portrait filter value for types with no obverse portrait. */
export const NO_PORTRAIT = "none"
/** Struck filter values: the person's own coinage, or coins others struck in their name. */
export const OWN = "own"
export const IN_NAME = "name"

export type PersonQuery = {
  /** Obverse portrait: a person id, NO_PORTRAIT, or null for all. */
  portrait: string | null
  /** Issuing authority: a person id, or null for all. */
  issuer: string | null
  denomination: string | null
  /** A catalogue date range, "103-111". */
  period: string | null
  /** OWN, IN_NAME, or null for both. */
  struck: string | null
  sort: Sort
  limit: number
  /** "1": only types with a photograph. */
  photo: string | null
}

export type Person = {
  id: string
  name: string
  ruled: string | null
  lived: string | null
  lead: string | null
  article: { url: string; licence: string } | null
  mainMint: { id: string; name: string } | null
  /** The category most of their own coins are in, with its ancestors, broadest first. */
  categoryPath: { id: string; name: string }[]
  family: { relation: string; people: { id: string; name: string }[] }[]
  /** Their own portrait across the reign: up to six types, evenly spaced, earliest to latest. */
  portraits: { typeId: string; src: string; years: string | null; reference: string; denomination: string | null }[]
  /**
   * Years for the portrait heading: the reign when known, else the span of their own issues
   * (not coins merely struck in their name, nor posthumous ones dated after their reign or death).
   */
  portraitSpan: string | null
  portraitCredits: PhotoCreditItem[]
  /** Whether each filter can narrow the person's whole coinage (more than one option without filters). */
  available: { struck: boolean; portrait: boolean; issuer: boolean; denomination: boolean; period: boolean }
  struckFacet: Facet[]
  /** Types struck in the person's name by others, across the whole coinage. */
  inNameCount: number
  portraitFacet: Facet[]
  issuerFacet: Facet[]
  denominationFacet: Facet[]
  periodFacet: Facet[]
  /** The "Photographed" toggle. */
  photographed: PhotoToggle
  total: number
  types: TypeCardData[]
  typeCredits: PhotoCreditItem[]
}

const RELATION_LABEL: Record<string, string> = { father: "Father", mother: "Mother", spouse: "Spouse", child: "Child" }

/* The filters of person `p`'s coinage. */
const filters = (p: number): Filter[] => [
  {
    name: "portrait",
    keep: (ix, v) => {
      if (v === NO_PORTRAIT) return (t) => !some(ix.person, t, (x) => (x & 7) === PORTRAIT)
      const q = find(ix.persons, v)
      return (t) => q >= 0 && some(ix.person, t, (x) => x === q * 8 + PORTRAIT)
    },
  },
  ISSUER,
  DENOMINATION,
  PERIOD,
  {
    name: "struck",
    keep: (ix, v) => {
      const named = inName(ix, p)
      return (t) => (v === IN_NAME) === named(t)
    },
  },
  PHOTO,
]

export function parseQuery(params: URLSearchParams): PersonQuery {
  const { slug, period, photo, sort, limit } = parseCommon(params)
  return {
    struck: params.get("struck") === OWN || params.get("struck") === IN_NAME ? params.get("struck") : null,
    portrait: slug("portrait"),
    issuer: slug("issuer"),
    denomination: slug("denomination"),
    period,
    photo,
    sort,
    limit,
  }
}

/** "356–323 BC"; "died 130 BC" or "born AD 53" when only one end is known. */
function lifespan(birth: number | null, death: number | null): string | null {
  if (birth != null && death != null) return yearRange(birth, death)
  if (death != null) return `died ${year(death)}`
  if (birth != null) return `born ${year(birth)}`
  return null
}

export async function getPerson(db: D1Database, id: string, query: PersonQuery): Promise<Person | null> {
  const person = await db
    .prepare(`SELECT id, name, definition, start_year, end_year, birth_year, death_year FROM person WHERE id = ?`)
    .bind(id)
    .first<{
      id: string
      name: string
      definition: string | null
      start_year: number | null
      end_year: number | null
      birth_year: number | null
      death_year: number | null
    }>()
  if (!person) return null

  const ix = await facetIndex(db)
  const pi = find(ix.persons, id)
  const c = coinage(ix, personBase(ix, id), filters(pi), [query.portrait, query.issuer, query.denomination, query.period, query.struck, query.photo])
  const named = inName(ix, pi)

  const [{ available, article, family, mainMint, ownSpan, categories, portraits }, grid_] = await Promise.all([
    sections(db, "person", id),
    cards(db, c.grid(query.sort, query.limit)),
  ])

  const art = article[0] as (typeof article)[number] | undefined

  const familyGroups = Object.entries(RELATION_LABEL)
    .map(([rel, label]) => {
      const people = family.filter((r) => r.relation === rel).map(({ id, name }) => ({ id, name }))
      const plural = people.length > 1 ? (rel === "child" ? "Children" : label + "s") : label
      return { relation: plural, people }
    })
    .filter((g) => g.people.length)

  // One portrait per start year that has a photo, then evenly spaced picks across the reign.
  const byYear = new Map<number, Person["portraits"][number]>()
  const imageIds = new Map<string, number>()
  for (const r of portraits) {
    if (r.image_id != null) imageIds.set(r.id, r.image_id)
    const src = iiif(r.iiif, 400) ?? secure(r.url)
    if (src && !byYear.has(r.start_year))
      byYear.set(r.start_year, {
        typeId: r.id,
        src,
        years: yearRange(r.start_year, r.end_year),
        reference: r.title ?? r.id,
        denomination: r.denomination,
      })
  }
  const all = [...byYear.values()]
  const picks =
    all.length <= PORTRAITS ? all : Array.from({ length: PORTRAITS }, (_, i) => all[Math.round((i * (all.length - 1)) / (PORTRAITS - 1))])

  const own = ownSpan[0] as (typeof ownSpan)[number] | undefined
  const portraitSpan = yearRange(person.start_year, person.end_year) ?? yearRange(own?.s ?? null, own?.e ?? null)
  const shownImages = picks.map((p) => imageIds.get(p.typeId)).filter((id): id is number => id != null)
  const portraitCredits = await getPhotoCredits(db, shownImages)

  const none = c.count("portrait", (t) => !some(ix.person, t, (x) => (x & 7) === PORTRAIT))
  const opts = available[0]

  return {
    id: person.id,
    name: person.name,
    ruled: yearRange(person.start_year, person.end_year),
    lived: lifespan(person.birth_year, person.death_year),
    lead: lead(art?.extract ?? person.definition),
    article: art ? { url: art.url, licence: art.licence } : null,
    mainMint: mainMint[0] ?? null,
    categoryPath: categories,
    family: familyGroups,
    portraits: picks,
    portraitSpan,
    portraitCredits,
    available: {
      struck: opts.own > 0 && opts.in_name > 0,
      portrait: opts.portrait > 1,
      issuer: opts.issuer > 1,
      denomination: opts.denomination > 1,
      period: opts.period > 1,
    },
    struckFacet: [
      { value: OWN, label: "Own issues", count: c.count("struck", (t) => !named(t)) },
      { value: IN_NAME, label: "Struck in their name", count: c.count("struck", named) },
    ],
    inNameCount: opts.in_name,
    portraitFacet: [
      // Whose portrait is on the obverse: the person first, then others by count.
      ...c.facet("portrait", portraitKeys(ix), ix.persons, pi),
      ...(none ? [{ value: NO_PORTRAIT, label: "No portrait", count: none }] : []),
    ],
    issuerFacet: c.facet("issuer", issuerKeys(ix), ix.persons, pi),
    denominationFacet: c.facet("denomination", denominationKeys(ix), ix.denominations),
    periodFacet: c.periods(),
    photographed: c.photo(),
    total: c.total(),
    types: grid_.types,
    typeCredits: grid_.typeCredits,
  }
}
