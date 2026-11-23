/*
 * Edge cache for pages that only change when the database is rebuilt or the site is deployed: the
 * coin type, person, mint, denomination, subject and collection pages, the index pages, the
 * sitemaps, and the data behind the Collections menu and the ⌘K palette. A cached copy is served
 * without running the page or touching D1. Copies are keyed by the database's build time
 * (build_info.built_at) and the deploy's version id, so loading a new database or deploying new
 * code retires them all at once (a page from the last deploy would link CSS and JS that are gone);
 * the build time itself is read at most once a minute per Worker instance.
 *
 * Off in dev, so edits show at once.
 */
import { defineMiddleware } from "astro:middleware"
import { env } from "cloudflare:workers"

const CACHED = [/^\/$/, /^\/collections\/?$/, /^\/mints\/?$/, /^\/mint\/[^/]+\/?$/, /^\/person\/[^/]+\/?$/, /^\/type\/.+$/, /^\/denominations\/?$/, /^\/denomination\/[^/]+\/?$/, /^\/subjects\/?$/, /^\/subject\/[^/]+\/?$/, /^\/category\/[^/]+\/?$/, /^\/people\/?$/, /^\/sources\/?$/, /^\/about\/?$/, /^\/api\/collections\.json$/, /^\/api\/search-index\.json$/, /^\/api\/search\.json$/, /^\/sitemap\.xml$/, /^\/sitemaps\/[^/]+$/]
const TTL = 60 * 60 * 24 // a day; the build key retires copies sooner when the data changes
const BUILD_CHECK_MS = 60_000

let build: { value: string; checkedAt: number } | null = null

async function buildId(): Promise<string> {
  if (build && Date.now() - build.checkedAt < BUILD_CHECK_MS) return build.value
  const row = await env.DB.prepare(`SELECT value FROM build_info WHERE key = 'built_at'`).first<{ value: string }>()
  build = { value: row?.value ?? "unknown", checkedAt: Date.now() }
  return build.value
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context
  // The people pages were once /rulers and /ruler/[id]; keep old links working, query and all.
  const moved = url.pathname.match(/^\/ruler(s)?(\/.*)?$/)
  if (moved) return context.redirect(`${moved[1] ? "/people" : "/person"}${moved[2] ?? ""}${url.search}`, 301)
  if (import.meta.env.DEV || request.method !== "GET" || !CACHED.some((re) => re.test(url.pathname))) return next()

  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(`${url.origin}${url.pathname}${url.search}${url.search ? "&" : "?"}__build=${encodeURIComponent(await buildId())}&__deploy=${env.CF_VERSION_METADATA.id}`)
  const hit = await cache.match(key)
  if (hit) return hit

  const response = await next()
  if (response.status === 200) {
    const copy = new Response(response.clone().body, response)
    copy.headers.set("Cache-Control", `public, s-maxage=${TTL}`)
    // Store after responding, so the first visitor isn't kept waiting.
    context.locals.cfContext.waitUntil(cache.put(key, copy))
  }
  return response
})
