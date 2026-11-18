/*
 * Coin-type cards, shared by every page that shows a grid of types (type page, ruler page, …).
 * CARD_SELECT selects one card's fields from `coin_type t`; append WHERE / ORDER BY / LIMIT.
 */
import { iiif, secure, shortDescription, yearRange } from "@/lib/format"

/*
 * Image hosts that refused to serve our pages in testing (Gallica returned 403). Their photos are
 * treated as missing. Revisit once BnF replies.
 */
export const REFUSING_HOST = `'%gallica.bnf.fr%'`

export type TypeCardData = {
  id: string
  reference: string
  title: string
  meta: string
  image: string | null
  /** The image shown, for its credit (lib/credits.ts). */
  imageId: number | null
}

export type CardRow = {
  id: string
  title: string | null
  rev_description: string | null
  start_year: number | null
  end_year: number | null
  denomination: string | null
  image: string | null
  iiif: string | null
  image_id: number | null
}

/* One reverse photo per type: prefer a reverse, then a combined image; IIIF first. */
const CARD_IMAGE = (col: string) => `
  (SELECT i.${col} FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
   WHERE st.type_id = t.id AND i.side IN ('reverse', 'combined') AND i.url NOT LIKE ${REFUSING_HOST}
   ORDER BY i.side = 'combined', i.iiif_service IS NULL LIMIT 1)`

export const CARD_SELECT = `
  SELECT t.id, t.title, t.rev_description, t.start_year, t.end_year,
    (SELECT d.name FROM type_denomination td JOIN denomination d ON d.id = td.denomination_id
     WHERE td.type_id = t.id LIMIT 1) AS denomination,
    ${CARD_IMAGE("url")} AS image,
    ${CARD_IMAGE("iiif_service")} AS iiif,
    ${CARD_IMAGE("id")} AS image_id
  FROM coin_type t`

export function card(row: CardRow): TypeCardData {
  return {
    id: row.id,
    reference: row.title ?? row.id,
    title: shortDescription(row.rev_description) ?? row.title ?? row.id,
    meta: [row.denomination, yearRange(row.start_year, row.end_year)].filter(Boolean).join(" · "),
    image: iiif(row.iiif, 600) ?? secure(row.image),
    imageId: row.image_id,
  }
}
