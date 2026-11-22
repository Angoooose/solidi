/*
 * Data for the ⌘K palette (components/search-command.tsx), from tables pipeline/search.py writes.
 *
 * - getSearchIndex: every person, mint, collection, denomination and subject, sent to the browser whole (a few thousand
 *   rows, fetched once when idle) so names match instantly, as you type, with no database reads.
 * - searchTypes: coin types by catalogue number, from the type_search FTS index; too many to send.
 */
import basemaps from "@/lib/basemaps.generated.json"
import { metaLine, photo, IMAGE_COLS, typesLabel } from "@/lib/categories"
import { shortDescription, typePath, yearRange } from "@/lib/format"
import { typeMatch } from "@/lib/searchQuery"
import { USABLE } from "@/lib/typeCards"

/** One row of the palette, as drawn: a name, a line under it, a link and a picture. */
export type SearchItem = {
  name: string
  meta: string
  href: string
  n: number
  thumb: string | null
  /** Collections: up to four coins from it, drawn as a grid. */
  thumbs?: string[]
  /** Mints: the mint on the all-mints basemap (public/maps/all.svg), in its pixels. */
  at?: [number, number]
}

export type SearchIndex = {
  people: SearchItem[]
  mints: SearchItem[]
  collections: SearchItem[]
  denominations: SearchItem[]
  subjects: SearchItem[]
}

type EntityRow = {
  kind: "person" | "mint" | "collection" | "denomination" | "subject"
  id: string
  name: string
  context: string | null
  start_year: number | null
  end_year: number | null
  n: number
  lat: number | null
  lon: number | null
  url: string | null
  thumb: string | null
  iiif: string | null
}

/* Mercator onto the all-mints basemap: the same projection scripts/basemaps.mjs fitted (centre 0, 0). */
const ALL = basemaps.all
function project(lon: number, lat: number): [number, number] | undefined {
  const rad = Math.PI / 180
  const x = ALL.translate[0] + ALL.scale * lon * rad
  const y = ALL.translate[1] - ALL.scale * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2))
  // Mints east of the map's edge (Bactria, India) get no map.
  return x >= 0 && x <= ALL.width && y >= 0 && y <= ALL.height ? [Math.round(x * 10) / 10, Math.round(y * 10) / 10] : undefined
}

export async function getSearchIndex(db: D1Database): Promise<SearchIndex> {
  const { results } = await db
    .prepare(
      `SELECT e.kind, e.id, e.name, e.context, e.start_year, e.end_year, e.n, e.lat, e.lon, ${IMAGE_COLS}
       FROM search_entity e LEFT JOIN image i ON i.id = e.image_id
       ORDER BY e.n DESC`
    )
    .all<EntityRow>()
  const coins = await collectionCoins(db)
  const index: SearchIndex = { people: [], mints: [], collections: [], denominations: [], subjects: [] }
  for (const r of results) {
    const thumb = photo(r)?.thumb ?? null
    if (r.kind === "person") {
      index.people.push({ name: r.name, meta: `Person · ${metaLine(r.start_year, r.end_year, r.n)}`, href: `/person/${r.id}`, n: r.n, thumb })
    } else if (r.kind === "mint") {
      index.mints.push({
        name: r.name,
        meta: ["Mint", r.context, typesLabel(r.n)].filter(Boolean).join(" · "),
        href: `/mint/${r.id}`,
        n: r.n,
        thumb: null,
        at: r.lat != null && r.lon != null ? project(r.lon, r.lat) : undefined,
      })
    } else if (r.kind === "denomination") {
      index.denominations.push({
        name: r.name,
        meta: ["Denomination", r.context, metaLine(r.start_year, r.end_year, r.n)].filter(Boolean).join(" · "),
        href: `/denomination/${r.id}`,
        n: r.n,
        thumb,
      })
    } else if (r.kind === "subject") {
      index.subjects.push({ name: r.name, meta: `Subject · ${metaLine(r.start_year, r.end_year, r.n)}`, href: `/subject/${r.id}`, n: r.n, thumb })
    } else {
      index.collections.push({
        name: r.name,
        meta: ["Collection", r.context, metaLine(r.start_year, r.end_year, r.n)].filter(Boolean).join(" · "),
        href: `/category/${r.id}`,
        n: r.n,
        thumb,
        thumbs: coins.get(r.id) ?? [],
      })
    }
  }
  return index
}

const GRID = 4

/* Each collection's coins for its grid: its most prolific people's portraits, then its main mints' coins. */
async function collectionCoins(db: D1Database): Promise<Map<string, string[]>> {
  const { results } = await db
    .prepare(
      `SELECT c.category_id, ${IMAGE_COLS}
       FROM (SELECT category_id, 0 AS src, rank, image_id FROM category_person WHERE image_id IS NOT NULL
             UNION ALL
             SELECT category_id, 1, rank, image_id FROM category_mint WHERE image_id IS NOT NULL) c
       JOIN image i ON i.id = c.image_id
       ORDER BY c.category_id, c.src, c.rank`
    )
    .all<{ category_id: string; url: string | null; thumb: string | null; iiif: string | null }>()
  const coins = new Map<string, string[]>()
  for (const r of results) {
    const list = coins.get(r.category_id) ?? []
    const thumb = photo(r)?.thumb
    if (thumb && list.length < GRID && !list.includes(thumb)) list.push(thumb)
    coins.set(r.category_id, list)
  }
  return coins
}

export type TypeHit = { reference: string; meta: string; href: string; thumb: string | null }

const TYPE_LIMIT = 8

/**
 * Types whose citation matches a query ending in a number: the number itself first, then the
 * shortest ("trajan 2", then 20–29, then 200…), main types before sub-variants, then by date and
 * catalogue order.
 */
export async function searchTypes(db: D1Database, q: string): Promise<TypeHit[]> {
  const m = typeMatch(q)
  if (!m) return []
  const { results } = await db
    .prepare(
      `WITH hits AS (
         SELECT d.type_id, row_number() OVER (ORDER BY d.num = ?2 DESC, length(d.num), d.child, d.start_year, d.sort_key) AS rk
         FROM type_search s JOIN type_search_doc d ON d.id = s.rowid
         WHERE type_search MATCH ?1
         ORDER BY rk LIMIT ?3)
       SELECT t.id, t.title, t.rev_description, t.start_year, t.end_year,
         (SELECT d.name FROM type_denomination td JOIN denomination d ON d.id = td.denomination_id
          WHERE td.type_id = t.id LIMIT 1) AS denomination,
         ${IMAGE_COLS}
       FROM hits JOIN coin_type t ON t.id = hits.type_id
       LEFT JOIN image i ON i.id = (
         SELECT i.id FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
         WHERE st.type_id = t.id AND i.side IN ('reverse', 'combined') AND ${USABLE("i")}
         ORDER BY i.side = 'combined', i.thumbnail_url IS NULL AND i.iiif_service IS NULL LIMIT 1)
       GROUP BY t.id
       ORDER BY min(hits.rk)`
    )
    .bind(m.match, m.num, TYPE_LIMIT)
    .all<{
      id: string
      title: string | null
      rev_description: string | null
      start_year: number | null
      end_year: number | null
      denomination: string | null
      url: string | null
      thumb: string | null
      iiif: string | null
    }>()
  return results.map((r) => ({
    reference: r.title ?? r.id,
    meta: [r.denomination, yearRange(r.start_year, r.end_year), shortDescription(r.rev_description)].filter(Boolean).join(" · "),
    href: typePath(r.id),
    thumb: photo(r)?.thumb ?? null,
  }))
}
