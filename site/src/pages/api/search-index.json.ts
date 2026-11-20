/* Every person, mint and collection for the ⌘K palette (lib/search.ts), fetched once when idle. */
import type { APIRoute } from "astro"
import { env } from "cloudflare:workers"
import { getSearchIndex } from "@/lib/search"

export const GET: APIRoute = async () =>
  Response.json(await getSearchIndex(env.DB), {
    headers: {
      // In production it changes only with a new database build; in dev, with every edit.
      "Cache-Control": import.meta.env.DEV ? "no-store" : "public, max-age=3600, stale-while-revalidate=86400",
    },
  })
