/*
 * Data for the About page: the headline numbers, a coin for each catalogue
 * (catalogue_stat's picked photo), and six coins of one type to show how real coins vary.
 */
import { IMAGE_COLS, photo, type ImageCols, type Photo } from "@/lib/categories"
import { sourceLabel } from "@/lib/footer"
import { secure } from "@/lib/format"
import { catalogueName } from "@/lib/sources"
import { sections } from "@/lib/summary/store"

/*
 * RIC II Trajan 98, and six of its coins chosen by hand for the spread of their wear, toning and
 * weight. Specimen ids are hashes of the holders' URIs, so they survive rebuilds; a coin that
 * drops out of the data just drops off the page. Holder names are shortened for a caption.
 */
export const EXAMPLE_TYPE = { id: "ocre/ric.2.tr.98", title: "RIC II Trajan 98", subject: "Dacia in mourning" }
const EXAMPLE_COINS: [string, string][] = [
  ["9164155e091d73a3", "American Numismatic Society"],
  ["cf0c8bee16d09873", "Ashmolean Museum"],
  ["e1b950fa443ab85c", "Münzkabinett Wien"],
  ["6d88e5d06037d6be", "University of Vienna"],
  ["708b3d4c1ce6ed5e", "University of Freiburg"],
  ["08a0daec74b8be0a", "University of Eichstätt-Ingolstadt"],
]

export type AboutCatalogue = { id: string; label: string; name: string; url: string | null; types: number; photo: Photo | null; alt: string }
export type AboutCoin = { id: string; holder: string; weight: number | null; diameter: number | null; photo: Photo | null }
export type About = {
  types: number
  coins: number
  photographed: number
  holders: number
  builtAt: string | null
  catalogues: AboutCatalogue[]
  example: { coins: AboutCoin[]; total: number; collections: number }
}

export async function getAbout(db: D1Database): Promise<About> {
  const ids = EXAMPLE_COINS.map(([id]) => id)
  const [{ totals }, [built, catalogues, coins, example]] = await Promise.all([sections(db, "totals", "site"), db.batch([
    db.prepare(`SELECT value FROM build_info WHERE key = 'built_at'`),
    db.prepare(`SELECT d.slug, d.name, d.id AS url, c.types, ${IMAGE_COLS},
                       (SELECT t.title FROM specimen_type st JOIN coin_type t ON t.id = st.type_id WHERE st.specimen_id = i.specimen_id LIMIT 1) AS title
                FROM catalogue_stat c JOIN dataset d ON d.id = c.dataset_id LEFT JOIN image i ON i.id = c.image_id
                WHERE d.slug IS NOT NULL ORDER BY c.types DESC`),
    db.prepare(`SELECT s.id, s.weight_g AS weight, s.diameter_mm AS diameter, ${IMAGE_COLS}
                FROM specimen s LEFT JOIN image i ON i.id = (SELECT id FROM image WHERE specimen_id = s.id AND side = 'reverse' AND usable = 1 ORDER BY id LIMIT 1)
                WHERE s.id IN (${ids.map(() => "?").join(",")})`).bind(...ids),
    // Every coin of the type and its sub-variants, and the collections holding them.
    db.prepare(`SELECT count(DISTINCT s.id) AS total, count(DISTINCT coalesce(s.institution_id, s.dataset_id)) AS collections
                FROM specimen_type st JOIN specimen s ON s.id = st.specimen_id
                WHERE st.type_id IN (SELECT id FROM coin_type WHERE id = ?1 OR parent_id = ?1)`).bind(EXAMPLE_TYPE.id),
  ])])

  const builtAt = (built.results[0] as { value: string } | undefined)?.value ?? null
  const byId = new Map((coins.results as (ImageCols & { id: string; weight: number | null; diameter: number | null })[]).map((r) => [r.id, r]))
  const e = example.results[0] as { total: number; collections: number }

  return {
    types: totals.types,
    coins: totals.specimens,
    photographed: totals.photographed,
    holders: totals.holders,
    builtAt,
    catalogues: (catalogues.results as (ImageCols & { slug: string; name: string; url: string; types: number; title: string | null })[]).map((r) => ({
      id: r.slug,
      label: sourceLabel(r.slug),
      name: catalogueName(r.slug, r.name),
      url: secure(r.url),
      types: r.types,
      photo: photo(r),
      alt: r.title ? `Obverse of ${r.title}` : "",
    })),
    example: {
      coins: EXAMPLE_COINS.flatMap(([id, holder]) => {
        const r = byId.get(id)
        return r ? [{ id, holder, weight: r.weight, diameter: r.diameter, photo: photo(r) }] : []
      }),
      total: e.total,
      collections: e.collections,
    },
  }
}
