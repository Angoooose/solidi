/* Coin types by catalogue number for the ⌘K palette (lib/search.ts): /api/search.json?q=RIC+II+22 */
import type { APIRoute } from "astro"
import { env } from "cloudflare:workers"
import { searchTypes } from "@/lib/search"

export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get("q") ?? "").slice(0, 100)
  return Response.json(
    { types: await searchTypes(env.DB, q) },
    { headers: { "Cache-Control": import.meta.env.DEV ? "no-store" : "public, max-age=3600, stale-while-revalidate=86400" } }
  )
}
