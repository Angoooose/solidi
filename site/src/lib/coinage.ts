/*
 * A filtered, sorted grid of coin types with a facet per filter: the "Coinage" section of the
 * person, mint, denomination and subject pages. Each page supplies its base (every type it
 * covers) and its filters; this module counts each facet, the total and the photo toggle, and
 * picks the grid's types, all from the facet index in memory (lib/facet/index.ts). Only the cards
 * shown are read from D1.
 *
 * Filters come from the URL so every view is shareable. A facet ignores its own filter, so each
 * option's count is what you'd get by choosing it. A value the index doesn't know matches nothing.
 */
import { yearRange } from "@/lib/format"
import { getPhotoCredits, type PhotoCreditItem } from "@/lib/credits"
import { CARD_SELECT, card, type CardRow, type TypeCardData } from "@/lib/typeCards"
import { AUTHORITY, ISSUER as ISSUER_ROLE, NONE, PHOTO as PHOTO_FLAG, PORTRAIT, ROOT, SIDES, SORTS, STATED, type Entry, type FacetIndex, type Relation, type Sort } from "@/lib/facet"

export const PAGE_SIZE = 30

export type { Sort }
export type Facet = { value: string; label: string; count: number }
/** Whether a type (its number in the facet index) is in the set. */
export type Pred = (t: number) => boolean
/** Calls `emit` with each value a type counts toward in a facet. */
export type Keys = (t: number, emit: (key: number) => void) => void

/** One filter: the types it keeps when `v` is chosen. */
export type Filter = { name: string; keep: (ix: FacetIndex, v: string) => Pred }

/** The "Photographed" toggle: types with a photo under the other filters, and whether the
 *  coinage has both photographed and unphotographed types (fixed per page, like `available`). */
export type PhotoToggle = { count: number; available: boolean }

const lookups = new WeakMap<Entry[], Map<string, number>>()
/** An entry's number in its dictionary, or -1. */
export function find(list: Entry[], id: string | null): number {
  if (id == null) return -1
  let m = lookups.get(list)
  if (!m) lookups.set(list, (m = new Map(list.map((e, i) => [e.id, i]))))
  return m.get(id) ?? -1
}

/** Whether any of a type's values of a relation passes `test`. */
export function some(r: Relation, t: number, test: (v: number) => boolean): boolean {
  for (let i = r.off[t]; i < r.off[t + 1]; i++) if (test(r.val[i])) return true
  return false
}
/** Each of a type's values of a relation. */
export function each(r: Relation, t: number, f: (v: number) => void) {
  for (let i = r.off[t]; i < r.off[t + 1]; i++) f(r.val[i])
}

const never: Pred = () => false
const isRoot = (ix: FacetIndex, t: number) => (ix.flags[t] & ROOT) !== 0
/** Struck at the mint or one of its workshops. */
const atMint = (ix: FacetIndex, m: number): Pred => (t) => ix.mint[t] !== NONE && (ix.mint[t] === m || ix.mintCity[ix.mint[t]] === m)
const issuedBy = (ix: FacetIndex, p: number): Pred => (t) => some(ix.person, t, (v) => v >> 3 === p && ((v & 7) === AUTHORITY || (v & 7) === ISSUER_ROLE))
const period = (ix: FacetIndex, t: number) => `${ix.start[t] === NONE ? "" : ix.start[t]}-${ix.end[t] === NONE ? "" : ix.end[t]}`

/* Filters most coinages share. */
export const DENOMINATION: Filter = {
  name: "denomination",
  keep: (ix, v) => {
    const d = find(ix.denominations, v)
    return d < 0 ? never : (t) => some(ix.denomination, t, (x) => x === d)
  },
}
export const MATERIAL: Filter = {
  name: "material",
  keep: (ix, v) => {
    const m = find(ix.materials, v)
    return m < 0 ? never : (t) => some(ix.material, t, (x) => x === m)
  },
}
export const ISSUER: Filter = {
  name: "issuer",
  keep: (ix, v) => {
    const p = find(ix.persons, v)
    return p < 0 ? never : issuedBy(ix, p)
  },
}
export const PERIOD: Filter = { name: "period", keep: (ix, v) => (t) => period(ix, t) === v }
/* A collection and everything under it (a link from a parent collection's list names the parent). */
export const COLLECTION: Filter = {
  name: "collection",
  keep: (ix, v) => {
    const c = find(ix.categories, v)
    if (c < 0) return never
    return (t) => {
      for (let x = ix.category[t]; x !== NONE; x = ix.categoryParent[x]) if (x === c) return true
      return false
    }
  },
}
/* A mint and its workshops. */
export const MINT: Filter = {
  name: "mint",
  keep: (ix, v) => {
    const m = find(ix.mints, v)
    return m < 0 ? never : atMint(ix, m)
  },
}
/* Only types whose card shows a photo (?photo=1). Every coinage has it, last in its filters. */
export const PHOTO: Filter = { name: "photo", keep: (ix) => (t) => (ix.flags[t] & PHOTO_FLAG) !== 0 }

/* Each coinage's base: every live type it covers. A person's includes subtypes. */
export const mintBase = (ix: FacetIndex, id: string): Pred => {
  const m = find(ix.mints, id)
  const at = atMint(ix, m)
  return m < 0 ? never : (t) => isRoot(ix, t) && at(t)
}
export const personBase = (ix: FacetIndex, id: string): Pred => {
  const p = find(ix.persons, id)
  return p < 0 ? never : (t) => some(ix.person, t, (v) => v >> 3 === p)
}
export const denominationBase = (ix: FacetIndex, id: string): Pred => {
  const d = find(ix.denominations, id)
  return d < 0 ? never : (t) => isRoot(ix, t) && some(ix.denomination, t, (x) => x === d)
}
export const subjectBase = (ix: FacetIndex, id: string): Pred => {
  const s = find(ix.subjects, id)
  return s < 0 ? never : (t) => isRoot(ix, t) && some(ix.subject, t, (v) => v >> 1 === s)
}

/* What a type counts toward in the common facets. */
export const issuerKeys = (ix: FacetIndex): Keys => (t, emit) =>
  each(ix.person, t, (v) => ((v & 7) === AUTHORITY || (v & 7) === ISSUER_ROLE) && emit(v >> 3))
export const portraitKeys = (ix: FacetIndex): Keys => (t, emit) => each(ix.person, t, (v) => (v & 7) === PORTRAIT && emit(v >> 3))
export const denominationKeys = (ix: FacetIndex): Keys => (t, emit) => each(ix.denomination, t, emit)
export const materialKeys = (ix: FacetIndex): Keys => (t, emit) => each(ix.material, t, emit)
/** The leaf collection it sits in. */
export const collectionKeys = (ix: FacetIndex): Keys => (t, emit) => ix.category[t] !== NONE && emit(ix.category[t])
/** Where it was struck, a workshop counted as its city. */
export const mintKeys = (ix: FacetIndex): Keys => (t, emit) => ix.mint[t] !== NONE && emit(ix.mintCity[ix.mint[t]])

/** Struck in the person's name by someone else: they are named on it but are not its authority. */
export const inName = (ix: FacetIndex, p: number): Pred => (t) =>
  some(ix.person, t, (v) => v === p * 8 + STATED) && !issuedBy(ix, p)(t)

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/** The URL parameters every coinage reads: sort, limit, and a slug or date range reader for filters. */
export function parseCommon(params: URLSearchParams) {
  const sort = params.get("sort") as Sort
  const limit = Number(params.get("limit"))
  return {
    slug: (k: string) => (SLUG.test(params.get(k) ?? "") ? params.get(k) : null),
    period: /^-?\d+--?\d+$/.test(params.get("date") ?? "") ? params.get("date") : null,
    photo: params.get("photo") === "1" ? "1" : null,
    sort: SORTS.includes(sort) ? sort : ("earliest" as Sort),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 600) : PAGE_SIZE,
  }
}

/**
 * One coinage: `base` is every type it covers, `filters` apply when their value in `values` (in
 * the same order) is set.
 */
export function coinage(ix: FacetIndex, base: Pred, filters: Filter[], values: (string | null)[]) {
  const keeps = filters.map((f, i) => (values[i] == null ? null : f.keep(ix, values[i]!)))
  // The base's types, and for each the filters it fails, one bit per filter.
  const types: number[] = []
  const fails: number[] = []
  for (let t = 0; t < ix.ids.length; t++) {
    if (!base(t)) continue
    let mask = 0
    keeps.forEach((keep, j) => keep && !keep(t) && (mask |= 1 << j))
    types.push(t)
    fails.push(mask)
  }
  const bit = (name: string) => {
    const j = filters.findIndex((f) => f.name === name)
    if (j < 0) throw new Error(`no filter ${name}`)
    return 1 << j
  }
  /** Each type that passes every filter but `except`'s. */
  const passing = (except: string | null, f: (t: number) => void) => {
    const ignore = except == null ? 0 : bit(except)
    types.forEach((t, i) => (fails[i] & ~ignore) === 0 && f(t))
  }

  return {
    /** Types counted under each key, by every filter but the facet's own. */
    counts(filter: string, keys: Keys): Map<number, number> {
      const counts = new Map<number, number>()
      const seen = new Map<number, number>()
      passing(filter, (t) =>
        keys(t, (k) => {
          if (seen.get(k) === t) return
          seen.set(k, t)
          counts.set(k, (counts.get(k) ?? 0) + 1)
        })
      )
      return counts
    },
    /** A facet's options from a dictionary: most types first, then by name; `first` leads. */
    facet(filter: string, keys: Keys, list: Entry[], first = -1): Facet[] {
      return ranked(this.counts(filter, keys), list, first)
    },
    /** Types passing every filter but `filter` that also pass `test`. */
    count(filter: string | null, test: Pred = () => true): number {
      let n = 0
      passing(filter, (t) => test(t) && n++)
      return n
    },
    /** Catalogue date ranges, earliest first, labelled by their dates: "AD 103–111". */
    periods(): Facet[] {
      const groups = new Map<string, { s: number; e: number; count: number }>()
      passing("period", (t) => {
        if (ix.start[t] === NONE) return
        const key = period(ix, t)
        const g = groups.get(key)
        if (g) g.count++
        else groups.set(key, { s: ix.start[t], e: ix.end[t], count: 1 })
      })
      return [...groups.entries()]
        .sort(([, a], [, b]) => a.s - b.s || a.e - b.e)
        .map(([value, g]) => ({ value, label: yearRange(g.s, g.e === NONE ? null : g.e) ?? value, count: g.count }))
    },
    photo(): PhotoToggle {
      const photographed = (t: number) => (ix.flags[t] & PHOTO_FLAG) !== 0
      const all = types.filter(photographed).length
      return { count: this.count("photo", photographed), available: all > 0 && all < types.length }
    },
    total(): number {
      return this.count(null)
    },
    /** The grid's type ids, in order. */
    grid(sort: Sort, limit: number): string[] {
      const shown: number[] = []
      passing(null, (t) => shown.push(t))
      const rank = sort === "latest" ? ix.latest : sort === "reference" ? ix.reference : null
      if (rank) shown.sort((a, b) => rank[a] - rank[b])
      return shown.slice(0, limit).map((t) => ix.ids[t])
    },
  }
}

/** Options by count, most first, then in dictionary (name) order; `first` leads. */
export function ranked(counts: Map<number, number>, list: Entry[], first = -1): Facet[] {
  return [...counts.entries()]
    .sort(([a, n], [b, m]) => Number(b === first) - Number(a === first) || m - n || a - b)
    .map(([k, count]) => ({ value: list[k].id, label: list[k].name, count }))
}

/** The side facet of a subject's coinage: obverse or reverse. */
export const sideKeys = (ix: FacetIndex, s: number): Keys => (t, emit) => each(ix.subject, t, (v) => v >> 1 === s && emit(v & 1))
export const sideLabels = SIDES.map((side) => ({ id: side, name: side[0].toUpperCase() + side.slice(1) }))

/** The grid's cards, in the order given, and the credits for their photos. */
export async function cards(db: D1Database, ids: string[]): Promise<{ types: TypeCardData[]; typeCredits: PhotoCreditItem[] }> {
  if (!ids.length) return { types: [], typeCredits: [] }
  const rows = await db.prepare(`${CARD_SELECT} WHERE t.id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all<CardRow>()
  const byId = new Map(rows.results.map((r) => [r.id, r]))
  const types = ids.flatMap((id) => (byId.has(id) ? [card(byId.get(id)!)] : []))
  const typeCredits = await getPhotoCredits(db, types.map((c) => c.imageId).filter((i): i is number => i != null))
  return { types, typeCredits }
}
