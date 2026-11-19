/*
 * Edge cache for pages that only change when the database is rebuilt: the collection pages, the
 * people list and the Collections menu's data. A cached copy is served without running the page
 * or touching D1. Copies are keyed by the database's build time (build_info.built_at), so loading
 * a new database retires them all at once; the build time itself is read at most once a minute
 * per Worker instance.
 *
 * Off in dev, so edits show at once.
 */
import { defineMiddleware } from "astro:middleware"
import { env } from "cloudflare:workers"

const CACHED = [/^\/collections\/?$/, /^\/mints\/?$/, /^\/mint\/[^/]+\/?$/, /^\/category\/[^/]+\/?$/, /^\/people\/?$/, /^\/api\/collections\.json$/]
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
  const key = new Request(`${url.origin}${url.pathname}${url.search}${url.search ? "&" : "?"}__build=${encodeURIComponent(await buildId())}`)
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
