/*
 * The facet index for the loaded database (lib/facet/index.ts), kept in memory per Worker
 * instance. It comes from KV under `facets:<built_at>`, put there by `npm run facets:remote`
 * beside the D1 load. If KV has none for this build (the upload was skipped), the Worker builds it
 * from D1 once (about two million rows read, a few seconds) and stores it for every instance after.
 */
import { env, waitUntil } from "cloudflare:workers"
import { builtAt } from "@/lib/build"
import { buildIndex, decodeIndex, encodeIndex, type FacetIndex } from "@/lib/facet"
import { facetKey } from "@/lib/facet/key"

let current: { built: string; index: Promise<FacetIndex> } | null = null

export async function facetIndex(db: D1Database): Promise<FacetIndex> {
  const built = await builtAt(db)
  if (current?.built !== built) {
    const index = load(db, built)
    current = { built, index }
    // A failed load is tried again by the next request, not remembered.
    index.catch(() => current?.index === index && (current = null))
  }
  return current.index
}

async function load(db: D1Database, built: string): Promise<FacetIndex> {
  const stored = await env.FACETS.get(facetKey(built), "arrayBuffer")
  if (stored) return decodeIndex(stored)
  const index = await buildIndex(async (sql) => (await db.prepare(sql).all()).results)
  waitUntil(env.FACETS.put(facetKey(index.builtAt), encodeIndex(index)))
  return index
}
