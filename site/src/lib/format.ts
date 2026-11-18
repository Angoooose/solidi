/* Small formatting helpers shared by pages. Pure functions, no data access. */

/** 103 → "AD 103", -27 → "27 BC". */
export function year(y: number): string {
  return y < 0 ? `${-y} BC` : `AD ${y}`
}

/** A date range as written in the catalogue: "AD 103–111", "27 BC – AD 14", "AD 112". */
export function yearRange(start: number | null, end: number | null): string | null {
  if (start == null && end == null) return null
  if (start == null || end == null || start === end) return year((start ?? end)!)
  if (start < 0 && end > 0) return `${year(start)} – ${year(end)}`
  if (start < 0) return `${-start}–${-end} BC`
  return `AD ${start}–${end}`
}

/** Page-safe image URL: many museum hosts still publish http:// links, which browsers block on https. */
export function secure(url: string | null | undefined): string | null {
  if (!url) return null
  return url.startsWith("http://") ? "https://" + url.slice(7) : url
}

/** A sized image from a IIIF Image API service, or null when there is no service. */
export function iiif(service: string | null | undefined, box: number): string | null {
  if (!service) return null
  return secure(`${service.replace(/\/info\.json$/, "").replace(/\/$/, "")}/full/!${box},${box}/0/default.jpg`)
}

const LICENCES: [RegExp, string][] = [
  [/publicdomain\/zero/i, "CC0"],
  [/publicdomain\/mark|NoC-US|public domain/i, "Public domain"],
  [/odbl/i, "ODbL"],
  [/by-nc-nd\/([\d.]+)/i, "CC BY-NC-ND $1"],
  [/by-nc-sa\/([\d.]+)/i, "CC BY-NC-SA $1"],
  [/by-nc\/([\d.]+)/i, "CC BY-NC $1"],
  [/by-sa\/([\d.]+)/i, "CC BY-SA $1"],
  [/by-nd\/([\d.]+)/i, "CC BY-ND $1"],
  [/by\/([\d.]+)/i, "CC BY $1"],
]

/** A licence as shown to readers: a short name, and the licence's own page when we have one. */
export type Licence = { label: string; url: string | null }

/** "https://creativecommons.org/licenses/by-nc-sa/4.0/" → { label: "CC BY-NC-SA 4.0", url: that page }. */
export function licence(raw: string | null | undefined): Licence | null {
  if (!raw) return null
  const url = /^https?:\/\//.test(raw) ? secure(raw) : null
  for (const [pattern, label] of LICENCES) {
    const m = raw.match(pattern)
    if (m) return { label: label.replace("$1", m[1] ?? ""), url }
  }
  return raw.length <= 40 ? { label: raw, url } : null
}

/* Database licences describe the dataset, not the photographs in it. */
const DATABASE_LICENCE = /odbl|opendatacommons/i

/**
 * The licence for a photograph: the dataset's image licence, else its data licence unless that is
 * a database licence (ODbL says nothing about the photos; showing it would misstate their terms).
 */
export function imageLicence(imageLicence: string | null, dataLicence: string | null): Licence | null {
  if (imageLicence) return licence(imageLicence)
  if (dataLicence && !DATABASE_LICENCE.test(dataLicence)) return licence(dataLicence)
  return null
}

/** First clause of an OCRE description, for card titles: "Dacian seated left …; round him …" → "Dacian seated left …". */
export function shortDescription(text: string | null | undefined): string | null {
  if (!text) return null
  return text.split(/;\s/)[0].trim()
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** ACSearch past-sales search for a type, by its RIC citation and ruler. */
export function acsearchUrl(ricVolume: string | null, ricNumber: string | null, ruler: string | null): string | null {
  if (!ricNumber) return null
  const term = [ruler, ricVolume ?? "RIC", ricNumber].filter(Boolean).join(" ")
  return `https://www.acsearch.info/search.html?term=${encodeURIComponent(term)}&category=1-2-3-4-5-6-7-8&images=1`
}
