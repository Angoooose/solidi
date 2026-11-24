/*
 * The facet index: every live coin type with what the Coinage grids filter, count and sort by
 * (lib/coinage.ts), as numbers in typed arrays. The grids work on it in memory and read only the
 * cards they show from D1, so a filtered view costs a few thousand rows rather than a scan of
 * every type the page covers (hundreds of thousands of rows on a big mint).
 *
 * Built from the database by `buildIndex`: by `npm run facets` from the pipeline's SQLite, uploaded
 * to KV beside the D1 load, or by the Worker itself from D1 when KV has none for the current build
 * (lib/facet/store.ts). Both run this one builder, so the index always means what the SQL did.
 *
 * Types are numbered in "earliest" order; `latest` and `reference` hold each type's position in
 * those orders. Names sort as SQLite sorts them (the dictionaries are read ORDER BY name), so a
 * dictionary index orders facets as `ORDER BY count DESC, name` did.
 */
import { HAS_CARD_IMAGE } from "@/lib/typeCards"

export type Sort = "earliest" | "latest" | "reference"

/* r is the type's primary catalogue reference; its sort_key orders volumes and numbers naturally. */
const ORDER: Record<Sort, string> = {
  earliest: `t.start_year IS NULL, t.start_year, t.end_year, r.sort_key, t.id`,
  latest: `t.start_year IS NULL, t.start_year DESC, t.end_year DESC, r.sort_key, t.id`,
  reference: `r.sort_key, t.id`,
}
export const SORTS = Object.keys(ORDER) as Sort[]

/** type_person roles, as stored in the index (person index * 8 + role). */
export const ROLES = ["authority", "issuer", "stated_authority", "portrait_obverse", "portrait_reverse"] as const
export const AUTHORITY = 0
export const ISSUER = 1
export const STATED = 2
export const PORTRAIT = 3
/** Sides, as stored in the index (subject or legend index * 2 + side). */
export const SIDES = ["obverse", "reverse"] as const

/** No value: a type without a mint, a collection or a date. */
export const NONE = -2147483648

export type Entry = { id: string; name: string }
/** One type's values of a relation are val[off[t]] … val[off[t + 1] - 1]. */
export type Relation = { off: Uint32Array; val: Uint32Array }

export type FacetIndex = {
  builtAt: string
  /** Type ids, in "earliest" order. */
  ids: string[]
  mints: Entry[]
  /** A mint's city (a workshop's parent), or itself. */
  mintCity: Int32Array
  categories: Entry[]
  categoryParent: Int32Array
  persons: Entry[]
  denominations: Entry[]
  materials: Entry[]
  subjects: Entry[]
  /** Normalised legends on a side that shows a subject (subject_legend's filter). */
  legends: string[]
  /** Bit 0: a top-level type (not a subtype); bit 1: its card shows a photo. */
  flags: Uint8Array
  mint: Int32Array
  /** Its primary collection. */
  category: Int32Array
  start: Int32Array
  end: Int32Array
  latest: Uint32Array
  reference: Uint32Array
  denomination: Relation
  material: Relation
  person: Relation
  subject: Relation
  legend: Relation
}

export const ROOT = 1
export const PHOTO = 2

/** Runs one query and returns its rows: D1 in the Worker, node:sqlite in `npm run facets`. */
export type Query = (sql: string) => Promise<Record<string, unknown>[]>

const LIVE = `t.replaced_by_id IS NULL`
const REF = `LEFT JOIN type_reference r ON r.type_id = t.id AND r.is_primary = 1`

export async function buildIndex(query: Query): Promise<FacetIndex> {
  const entries = async (table: string) => (await query(`SELECT id, name FROM ${table} ORDER BY name, id`)) as Entry[]
  const [built, mintRows, categoryRows, persons, denominations, materials, subjects, types, latestIds, referenceIds] = await Promise.all([
    query(`SELECT value FROM build_info WHERE key = 'built_at'`),
    query(`SELECT id, name, parent_id AS parent FROM mint ORDER BY name, id`),
    query(`SELECT id, name, parent_id AS parent FROM category ORDER BY name, id`),
    entries("person"),
    entries("denomination"),
    entries("material"),
    entries("subject"),
    query(`SELECT t.id, t.parent_id IS NULL AS root, ${HAS_CARD_IMAGE} AS photo, t.mint_id AS mint, tc.category_id AS category,
             t.start_year AS s, t.end_year AS e
           FROM coin_type t LEFT JOIN type_category tc ON tc.type_id = t.id AND tc.is_primary = 1 ${REF}
           WHERE ${LIVE} ORDER BY ${ORDER.earliest}`),
    query(`SELECT t.id FROM coin_type t ${REF} WHERE ${LIVE} ORDER BY ${ORDER.latest}`),
    query(`SELECT t.id FROM coin_type t ${REF} WHERE ${LIVE} ORDER BY ${ORDER.reference}`),
  ])
  const n = types.length
  const ids = types.map((r) => r.id as string)
  const typeIndex = new Map(ids.map((id, i) => [id, i]))
  const lookup = (list: { id: string }[]) => new Map(list.map((e, i) => [e.id, i]))

  const mints = mintRows.map((r) => ({ id: r.id as string, name: r.name as string }))
  const mintIndex = lookup(mints)
  const mintCity = Int32Array.from(mintRows, (r, i) => (r.parent == null ? i : (mintIndex.get(r.parent as string) ?? i)))
  const categories = categoryRows.map((r) => ({ id: r.id as string, name: r.name as string }))
  const categoryIndex = lookup(categories)
  const categoryParent = Int32Array.from(categoryRows, (r) => (r.parent == null ? NONE : (categoryIndex.get(r.parent as string) ?? NONE)))

  const flags = new Uint8Array(n)
  const mint = new Int32Array(n)
  const category = new Int32Array(n)
  const start = new Int32Array(n)
  const end = new Int32Array(n)
  types.forEach((r, i) => {
    flags[i] = (r.root ? ROOT : 0) | (r.photo ? PHOTO : 0)
    mint[i] = r.mint == null ? NONE : (mintIndex.get(r.mint as string) ?? NONE)
    category[i] = r.category == null ? NONE : (categoryIndex.get(r.category as string) ?? NONE)
    start[i] = r.s == null ? NONE : Number(r.s)
    end[i] = r.e == null ? NONE : Number(r.e)
  })
  const rank = (rows: Record<string, unknown>[]) => {
    const out = new Uint32Array(n)
    rows.forEach((r, pos) => (out[typeIndex.get(r.id as string)!] = pos))
    return out
  }

  /* A relation from rows of (type, value): `value` returns the stored number, or null to skip the row. */
  const relation = (rows: Record<string, unknown>[], value: (r: Record<string, unknown>) => number | null): Relation => {
    const lists: number[][] = Array.from({ length: n }, () => [])
    for (const r of rows) {
      const t = typeIndex.get(r.type_id as string)
      const v = t == null ? null : value(r)
      if (t != null && v != null) lists[t].push(v)
    }
    const off = new Uint32Array(n + 1)
    lists.forEach((l, t) => (off[t + 1] = off[t] + l.length))
    const val = new Uint32Array(off[n])
    lists.forEach((l, t) => val.set(l.sort((a, b) => a - b), off[t]))
    return { off, val }
  }
  const by = (index: Map<string, number>, col: string) => (r: Record<string, unknown>) => index.get(r[col] as string) ?? null
  const personIndex = lookup(persons)
  const subjectIndex = lookup(subjects)

  const [denominationRows, materialRows, personRows, subjectRows, legendRows] = await Promise.all([
    query(`SELECT type_id, denomination_id FROM type_denomination`),
    query(`SELECT type_id, material_id FROM type_material`),
    query(`SELECT type_id, person_id, role FROM type_person`),
    query(`SELECT type_id, subject_id, side FROM type_subject`),
    query(`SELECT DISTINCT g.type_id, g.side, g.normalised FROM legend g
           WHERE EXISTS (SELECT 1 FROM type_subject s WHERE s.type_id = g.type_id AND s.side = g.side)`),
  ])
  const legends = [...new Set(legendRows.map((r) => r.normalised as string))].sort()
  const legendIndex = new Map(legends.map((l, i) => [l, i]))
  const sided = (index: Map<string, number>, col: string) => (r: Record<string, unknown>) => {
    const i = index.get(r[col] as string)
    const side = SIDES.indexOf(r.side as (typeof SIDES)[number])
    return i == null || side < 0 ? null : i * 2 + side
  }

  return {
    builtAt: (built[0]?.value as string | undefined) ?? "unknown",
    ids,
    mints,
    mintCity,
    categories,
    categoryParent,
    persons,
    denominations,
    materials,
    subjects,
    legends,
    flags,
    mint,
    category,
    start,
    end,
    latest: rank(latestIds),
    reference: rank(referenceIds),
    denomination: relation(denominationRows, by(lookup(denominations), "denomination_id")),
    material: relation(materialRows, by(lookup(materials), "material_id")),
    person: relation(personRows, (r) => {
      const p = personIndex.get(r.person_id as string)
      const role = ROLES.indexOf(r.role as (typeof ROLES)[number])
      return p == null || role < 0 ? null : p * 8 + role
    }),
    subject: relation(subjectRows, sided(subjectIndex, "subject_id")),
    legend: relation(legendRows, sided(legendIndex, "normalised")),
  }
}

/*
 * The stored form: "SFX1", the length of a JSON header (the strings), then the typed arrays it
 * lists, each starting on a 4-byte boundary so they can be read in place.
 */
const MAGIC = 0x31584653 // "SFX1", little-endian
type ArrayKind = "u8" | "i32" | "u32"
const ARRAYS: [string, ArrayKind][] = [
  ["mintCity", "i32"], ["categoryParent", "i32"], ["flags", "u8"], ["mint", "i32"], ["category", "i32"], ["start", "i32"],
  ["end", "i32"], ["latest", "u32"], ["reference", "u32"],
  ...(["denomination", "material", "person", "subject", "legend"] as const).flatMap((r): [string, ArrayKind][] => [[`${r}.off`, "u32"], [`${r}.val`, "u32"]]),
]
const get = (ix: FacetIndex, path: string) => path.split(".").reduce<any>((o, k) => o[k], ix) as Uint8Array | Int32Array | Uint32Array

export function encodeIndex(ix: FacetIndex): Uint8Array {
  const { builtAt, ids, mints, categories, persons, denominations, materials, subjects, legends } = ix
  const lengths = ARRAYS.map(([path]) => get(ix, path).length)
  const header = new TextEncoder().encode(JSON.stringify({ builtAt, ids, mints, categories, persons, denominations, materials, subjects, legends, lengths }))
  const pad = (x: number) => (x + 3) & ~3
  let size = pad(8 + header.length)
  const offsets = ARRAYS.map(([path]) => {
    const at = size
    size = pad(size + get(ix, path).byteLength)
    return at
  })
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, header.length, true)
  out.set(header, 8)
  ARRAYS.forEach(([path], i) => {
    const a = get(ix, path)
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offsets[i])
  })
  return out
}

export function decodeIndex(buf: ArrayBuffer): FacetIndex {
  const view = new DataView(buf)
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a facet index")
  const headerLength = view.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLength)))
  const ix: any = { ...header, denomination: {}, material: {}, person: {}, subject: {}, legend: {} }
  delete ix.lengths
  const pad = (x: number) => (x + 3) & ~3
  let at = pad(8 + headerLength)
  ARRAYS.forEach(([path, kind], i) => {
    const length = header.lengths[i] as number
    const array = kind === "u8" ? new Uint8Array(buf, at, length) : kind === "i32" ? new Int32Array(buf, at, length) : new Uint32Array(buf, at, length)
    const [a, b] = path.split(".")
    if (b) ix[a][b] = array
    else ix[a] = array
    at = pad(at + array.byteLength)
  })
  return ix as FacetIndex
}
