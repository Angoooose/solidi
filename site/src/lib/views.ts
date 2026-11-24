/*
 * The query parameters each edge-cached page reads. The edge cache (src/middleware.ts) redirects
 * away any other parameter, and repeats of one, so they can't each make a fresh render of the page
 * (?x=1, ?x=2…), and keys what's left in sorted order. Values aren't checked: a page ignores one it
 * doesn't know. A new parameter must be added here, or it is redirected away.
 */
const COINAGE = ["sort", "limit", "photo"]

const VIEWS: [RegExp, string[]][] = [
  [/^\/mint\/[^/]+\/?$/, [...COINAGE, "collection", "issuer", "denomination", "material", "people"]],
  [/^\/person\/[^/]+\/?$/, [...COINAGE, "struck", "portrait", "issuer", "denomination", "date"]],
  [/^\/denomination\/[^/]+\/?$/, [...COINAGE, "collection", "issuer", "mint", "size", "list"]],
  [/^\/subject\/[^/]+\/?$/, [...COINAGE, "collection", "issuer", "denomination", "side", "legend", "list"]],
  [/^\/people\/?$/, ["collection", "sort"]],
  [/^\/mints\/?$/, ["collection", "sort", "q", "limit", "region"]],
  [/^\/denominations\/?$/, ["collection", "sort", "q", "limit", "metal"]],
  [/^\/subjects\/?$/, ["collection", "sort", "group"]],
  [/^\/collections\/?$/, ["order"]],
  [/^\/api\/search\.json$/, ["q"]],
]

/** `query`: the request's own query without unknown or repeated parameters; `key`: the same, sorted. */
export function normalizeQuery(url: URL): { query: string; key: string; changed: boolean } {
  const names = VIEWS.find(([re]) => re.test(url.pathname))?.[1] ?? []
  const kept = new URLSearchParams()
  for (const [k, v] of url.searchParams) if (names.includes(k) && !kept.has(k)) kept.set(k, v)
  const changed = kept.size !== [...url.searchParams].length
  const query = kept.toString()
  kept.sort()
  return { query: query && `?${query}`, key: kept.toString(), changed }
}
