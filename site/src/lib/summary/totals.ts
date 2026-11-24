/*
 * Site-wide totals for the footer (lib/footer.ts) and the About page (lib/about.ts). Counting every
 * specimen reads the whole table, about 445,000 rows, and the footer is on every page: its
 * per-instance cache doesn't help much when Cloudflare spreads traffic over many short-lived
 * instances.
 */
export type SiteTotals = {
  totals: { specimens: number; holders: number; types: number; photographed: number }
}

export async function siteTotals(db: D1Database): Promise<SiteTotals> {
  const totals = await db
    .prepare(`SELECT (SELECT count(*) FROM specimen) AS specimens, (SELECT count(*) FROM institution) AS holders,
                     (SELECT sum(types) FROM catalogue_stat) AS types, (SELECT sum(photographed) FROM photo_source) AS photographed`)
    .first<SiteTotals["totals"]>()
  return { totals: totals! }
}
