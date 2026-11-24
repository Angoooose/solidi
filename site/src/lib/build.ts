/*
 * When the loaded database was built (build_info.built_at): the key for everything derived from
 * it, the edge cache (src/middleware.ts) and the facet index (lib/facet/store.ts). Read at most
 * once a minute per Worker instance, so a new database is picked up within a minute.
 */
const CHECK_MS = 60_000

let build: { value: string; checkedAt: number } | null = null

export async function builtAt(db: D1Database): Promise<string> {
  if (build && Date.now() - build.checkedAt < CHECK_MS) return build.value
  const row = await db.prepare(`SELECT value FROM build_info WHERE key = 'built_at'`).first<{ value: string }>()
  build = { value: row?.value ?? "unknown", checkedAt: Date.now() }
  return build.value
}
