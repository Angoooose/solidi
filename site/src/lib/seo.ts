/*
 * What search engines index: each page's canonical URL (layouts/Base.astro) and the sitemaps
 * (pages/sitemap.xml.ts, pages/sitemaps/[name].ts).
 *
 * A page is indexed in one form: without a query string. The exception is an index page scoped to
 * one collection (/people?collection=roman-imperial, "Emperors · Roman Imperial"), a list of its
 * own. Every other query (filters, sorts, tabs, "Show more", search) is a view of a page: it is
 * marked noindex, follow and names the page itself as canonical, so its links are still followed.
 */
import { typePath } from "@/lib/format"

const SCOPED_INDEXES = ["/people", "/mints", "/denominations", "/subjects"]

export function canonicalView(url: URL): { canonical: string; indexable: boolean } {
  const path = url.pathname
  const keys = [...url.searchParams.keys()]
  if (keys.length === 0) return { canonical: path, indexable: true }
  const collection = url.searchParams.get("collection")
  if (collection && SCOPED_INDEXES.includes(path.replace(/\/$/, ""))) {
    // Sorted or filtered within a collection: still that collection's list.
    return { canonical: `${path}?collection=${encodeURIComponent(collection)}`, indexable: keys.length === 1 }
  }
  return { canonical: path, indexable: false }
}

/** Search engines take at most 50,000 URLs per sitemap; type sitemaps stay well under. */
export const TYPES_PER_SITEMAP = 40_000

const STATIC_PAGES = ["/", "/people", "/mints", "/denominations", "/subjects", "/collections", "/about", "/sources"]

/** When the database was built: every page's lastmod, since pages change only with a new build. */
export async function builtAt(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM build_info WHERE key = 'built_at'`).first<{ value: string }>()
  return row?.value ?? null
}

/** Live coin types (replaced ones redirect), for the type sitemaps. */
export async function typeCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM coin_type WHERE replaced_by_id IS NULL`).first<{ n: number }>()
  return row?.n ?? 0
}

/** One type sitemap's paths: the nth block of live types, by id. */
export async function typePaths(db: D1Database, n: number): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT id FROM coin_type WHERE replaced_by_id IS NULL ORDER BY id LIMIT ? OFFSET ?`)
    .bind(TYPES_PER_SITEMAP, (n - 1) * TYPES_PER_SITEMAP)
    .all<{ id: string }>()
  return rows.results.map((r) => typePath(r.id))
}

/**
 * Every other indexable page: the index pages, each scoped to each collection, the collections,
 * and every person, mint, denomination and subject with a page. A workshop's URL redirects to its
 * city, so only city mints are listed.
 */
export async function pagePaths(db: D1Database): Promise<string[]> {
  const ids = async (sql: string) => (await db.prepare(sql).all<{ id: string }>()).results.map((r) => r.id)
  /* The collections an index page can be scoped to: those with entries in its list (an empty one is a 404). */
  const scoped = (table: string) =>
    ids(`SELECT id FROM category c WHERE EXISTS (SELECT 1 FROM ${table} x WHERE x.category_id = c.id) ORDER BY sort_order`)
  const [categories, people, mints, denominations, subjects, ...lists] = await Promise.all([
    ids(`SELECT id FROM category ORDER BY sort_order`),
    ids(`SELECT id FROM person p WHERE EXISTS (SELECT 1 FROM type_person tp WHERE tp.person_id = p.id) ORDER BY id`),
    ids(
      `SELECT id FROM mint m WHERE m.parent_id IS NULL AND EXISTS (
         SELECT 1 FROM coin_type t WHERE t.mint_id = m.id OR t.mint_id IN (SELECT c.id FROM mint c WHERE c.parent_id = m.id)
       ) ORDER BY id`
    ),
    // Their pages read the pipeline's summary rows, which count only live types: no row, no page.
    ids(`SELECT denomination_id AS id FROM denomination_stat ORDER BY id`),
    ids(`SELECT subject_id AS id FROM subject_stat ORDER BY id`),
    // In SCOPED_INDEXES order.
    scoped("category_person"),
    scoped("category_mint"),
    scoped("category_denomination"),
    scoped("category_subject"),
  ])
  const at = (prefix: string, list: string[]) => list.map((id) => `${prefix}/${encodeURIComponent(id)}`)
  return [
    ...STATIC_PAGES,
    ...SCOPED_INDEXES.flatMap((p, i) => lists[i].map((c) => `${p}?collection=${encodeURIComponent(c)}`)),
    ...at("/category", categories),
    ...at("/person", people),
    ...at("/mint", mints),
    ...at("/denomination", denominations),
    ...at("/subject", subjects),
  ]
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** A sitemap (`urlset`) or sitemap index (`sitemapindex`) of absolute URLs. */
export function sitemapXml(kind: "urlset" | "sitemapindex", site: URL, paths: string[], lastmod: string | null): Response {
  const tag = kind === "urlset" ? "url" : "sitemap"
  const mod = lastmod ? `<lastmod>${escape(lastmod.slice(0, 10))}</lastmod>` : ""
  const body = paths.map((p) => `<${tag}><loc>${escape(new URL(p, site).href)}</loc>${mod}</${tag}>`).join("\n")
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<${kind} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</${kind}>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } }
  )
}
