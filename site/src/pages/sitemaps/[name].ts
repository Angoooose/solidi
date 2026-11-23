/*
 * /sitemaps/pages.xml (index pages, collections, people, mints, denominations, subjects) and
 * /sitemaps/types-N.xml (the Nth block of coin types). Listed by /sitemap.xml; lib/seo.ts.
 */
import type { APIRoute } from "astro"
import { env } from "cloudflare:workers"
import { builtAt, pagePaths, sitemapXml, typeCount, typePaths, TYPES_PER_SITEMAP } from "@/lib/seo"

export const GET: APIRoute = async ({ params, site, url }) => {
  const base = site ?? new URL(url.origin)
  const name = params.name ?? ""
  const lastmod = await builtAt(env.DB)
  if (name === "pages.xml") return sitemapXml("urlset", base, await pagePaths(env.DB), lastmod)

  const n = Number(name.match(/^types-(\d+)\.xml$/)?.[1])
  if (n >= 1 && n <= Math.ceil((await typeCount(env.DB)) / TYPES_PER_SITEMAP)) {
    return sitemapXml("urlset", base, await typePaths(env.DB, n), lastmod)
  }
  return new Response("Not found", { status: 404 })
}
