/*
 * Coin-type cards, shared by every page that shows a grid of types (type page, ruler page, …).
 * CARD_SELECT selects one card's fields from `coin_type t`; append WHERE / ORDER BY / LIMIT.
 */
import { iiif, plinthLegend, secure, shortDescription, yearRange } from "@/lib/format"

/*
 * Photos our pages can show: the pipeline flags hosts browsers refuse (Gallica's 403s, Kenom's
 * ORB-blocked IIIF redirects) as image.usable = 0 (data/sources.yaml unusable_image_hosts).
 */
export const USABLE = (alias: string) => `${alias}.usable = 1`

export type TypeCardData = {
  id: string
  reference: string
  title: string
  meta: string
  image: string | null
  /** The image shown, for its credit (lib/credits.ts). */
  imageId: number | null
  /** Without a photo, the plinth shows this legend pressed into it (lib/format.ts plinthLegend). */
  plinthLegend: string[] | null
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
  obv_card_legend: string | null
  rev_card_legend: string | null
}

/* A side's legend in Latin or Greek letters, which EB Garamond can set; other scripts give null. */
const CARD_LEGEND = (side: string) => `
  (SELECT l.legend FROM legend l WHERE l.type_id = t.id AND l.side = '${side}' AND l.language IN ('la', 'grc')
   ORDER BY l.id LIMIT 1)`

/* The photos a card can show for `coin_type t`: a reverse or combined image browsers can load. */
const CARD_IMAGES = `FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
   WHERE st.type_id = t.id AND i.side IN ('reverse', 'combined') AND ${USABLE("i")}`

/* One reverse photo per type: prefer a reverse, then a combined image; IIIF first. */
const CARD_IMAGE = (col: string) => `
  (SELECT i.${col} ${CARD_IMAGES}
   ORDER BY i.side = 'combined', i.iiif_service IS NULL LIMIT 1)`

/** Whether `coin_type t`'s card shows a photo (rather than the plinth): the "Photographed" filter. */
export const HAS_CARD_IMAGE = `EXISTS (SELECT 1 ${CARD_IMAGES})`

export const CARD_SELECT = `
  SELECT t.id, t.title, t.rev_description, t.start_year, t.end_year,
    (SELECT d.name FROM type_denomination td JOIN denomination d ON d.id = td.denomination_id
     WHERE td.type_id = t.id LIMIT 1) AS denomination,
    ${CARD_IMAGE("url")} AS image,
    ${CARD_IMAGE("iiif_service")} AS iiif,
    ${CARD_IMAGE("id")} AS image_id,
    ${CARD_LEGEND("obverse")} AS obv_card_legend,
    ${CARD_LEGEND("reverse")} AS rev_card_legend
  FROM coin_type t`

export function card(row: CardRow): TypeCardData {
  return {
    id: row.id,
    reference: row.title ?? row.id,
    title: shortDescription(row.rev_description) ?? row.title ?? row.id,
    meta: [row.denomination, yearRange(row.start_year, row.end_year)].filter(Boolean).join(" · "),
    image: iiif(row.iiif, 600) ?? secure(row.image),
    imageId: row.image_id,
    // The reverse legend first: in a grid the obverse is usually the same ruler's name on every card.
    plinthLegend: plinthLegend(row.rev_card_legend) ?? plinthLegend(row.obv_card_legend),
  }
}
