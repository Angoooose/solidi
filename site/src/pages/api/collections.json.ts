/* The Collections menu's data (lib/collections.ts). Fetched by the header menu on first idle. */
import type { APIRoute } from "astro"
import { env } from "cloudflare:workers"
import { getCollectionsMenu } from "@/lib/collections"

export const GET: APIRoute = async () =>
  Response.json(await getCollectionsMenu(env.DB), {
    headers: {
      // In production it changes only with a new database build; in dev, with every edit.
      "Cache-Control": import.meta.env.DEV ? "no-store" : "public, max-age=3600, stale-while-revalidate=86400",
    },
  })
