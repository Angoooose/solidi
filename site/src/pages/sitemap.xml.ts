/*
 * /sitemap.xml: the sitemap index. One sitemap of pages, then the coin types in blocks of
 * TYPES_PER_SITEMAP (lib/seo.ts). Edge-cached per database build (middleware.ts).
 */
import type { APIRoute } from "astro"
import { env } from "cloudflare:workers"
import { builtAt, sitemapXml, typeCount, TYPES_PER_SITEMAP } from "@/lib/seo"

export const GET: APIRoute = async ({ site, url }) => {
  const [count, lastmod] = await Promise.all([typeCount(env.DB), builtAt(env.DB)])
  const blocks = Math.ceil(count / TYPES_PER_SITEMAP)
  const paths = ["/sitemaps/pages.xml", ...Array.from({ length: blocks }, (_, i) => `/sitemaps/types-${i + 1}.xml`)]
  return sitemapXml("sitemapindex", site ?? new URL(url.origin), paths, lastmod)
}
