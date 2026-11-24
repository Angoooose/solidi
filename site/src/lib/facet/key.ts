/** Where a database build's facet index is kept in KV: by the Worker (lib/facet/store.ts) and `npm run facets`. */
export const facetKey = (built: string) => `facets:${built}`
