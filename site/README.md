# solidi.org

The Astro site, on a Cloudflare Worker with the database in D1. See the [root README](../README.md) for local setup.

## Loading a new database build

Two steps precompute page data from a build. Skipping either is safe, but pages then compute it from D1 at request time, which is slower and reads far more rows.

```sh
npm run summaries          # after `solidi build`, before `solidi export-d1`: each page's filter-free sections (src/lib/summary/)
# export, then load build/solidi-*.sql into the remote D1
npm run facets:remote      # after loading: the coinage filter index, to KV (src/lib/facet/)
```
