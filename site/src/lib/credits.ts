/*
 * Who holds the photographs a page shows, and under what licence. Pages pass the image ids they
 * display; components/credits.tsx turns the result into a credit line.
 */
import { imageLicence, secure, type Licence } from "@/lib/format"

export type PhotoCreditItem = {
  holder: string
  /** The holder's record for the coin. */
  sourceUrl: string | null
  licence: Licence | null
}

/** Where every "Image credits" link points (pages/sources.astro). */
export const IMAGE_CREDITS_URL = "/sources#images"

/**
 * SQL for the name of the collection holding a specimen: its institution, else its dataset.
 * Some names carry an HTML line break from the source; it becomes a space.
 */
export const holderName = (specimenId: string) =>
  `(SELECT replace(replace(coalesce(hn.name, hd.name), '<br> ', '<br>'), '<br>', ' ')
    FROM specimen hs LEFT JOIN institution hn ON hn.id = hs.institution_id LEFT JOIN dataset hd ON hd.id = hs.dataset_id
    WHERE hs.id = ${specimenId})`

/** The image ids of the photos a page shows, for getPhotoCredits. */
export const photoIds = (photos: ({ id?: number | null } | null | undefined)[]): number[] =>
  photos.flatMap((p) => (p?.id != null ? [p.id] : []))

/* D1 allows at most 100 bound parameters per statement. */
const CHUNK = 90

export async function getPhotoCredits(db: D1Database, imageIds: number[]): Promise<PhotoCreditItem[]> {
  const ids = [...new Set(imageIds)]
  if (!ids.length) return []
  const chunks = Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK))
  const results = await db.batch(
    chunks.map((chunk) =>
      db
        .prepare(
          `SELECT i.id, coalesce(${holderName("i.specimen_id")}, 'Unknown collection') AS holder, s.source_uri,
             d.image_licence, d.data_licence
           FROM image i JOIN specimen s ON s.id = i.specimen_id
           LEFT JOIN institution n ON n.id = s.institution_id LEFT JOIN dataset d ON d.id = s.dataset_id
           WHERE i.id IN (${chunk.map(() => "?").join(",")})`
        )
        .bind(...chunk)
    )
  )
  const byId = new Map<number, PhotoCreditItem>()
  for (const r of results.flatMap((res) => res.results) as {
    id: number
    holder: string
    source_uri: string | null
    image_licence: string | null
    data_licence: string | null
  }[]) {
    byId.set(r.id, { holder: r.holder, sourceUrl: secure(r.source_uri), licence: imageLicence(r.image_licence, r.data_licence) })
  }
  // In the order the page shows them.
  return ids.map((id) => byId.get(id)).filter((c): c is PhotoCreditItem => !!c)
}
