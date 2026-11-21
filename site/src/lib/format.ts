/* Small formatting helpers shared by pages. Pure functions, no data access. */

/**
 * URL of a coin-type page. IDs are '{dataset}/{source id}' and keep their slash; a few source IDs
 * contain '?' or '#' ('ocre/ric.2.hdn.312a?'), which must be escaped.
 */
export function typePath(id: string): string {
  return `/type/${encodeURI(id).replace(/[?#]/g, encodeURIComponent)}`
}

/** 103 → "AD 103", -27 → "27 BC". */
export function year(y: number): string {
  return y < 0 ? `${-y} BC` : `AD ${y}`
}

/**
 * A date range as written in the catalogue: "AD 103–111", "336–323 BC", "27 BC – AD 14", "AD 112".
 * Always earliest first, even if the source gave the years the other way round.
 */
export function yearRange(start: number | null, end: number | null): string | null {
  if (start == null && end == null) return null
  if (start == null || end == null || start === end) return year((start ?? end)!)
  if (start > end) [start, end] = [end, start]
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
  const raw = imageLicence ?? (dataLicence && !DATABASE_LICENCE.test(dataLicence) ? dataLicence : null)
  if (!raw) return null
  const known = licence(raw)
  if (known && (LICENCES.some(([pattern]) => pattern.test(raw)) || !/^https?:\/\//.test(raw))) return known
  // A terms page of its own (Harvard, MFA), or a statement too long to show (Berlin's imprint, Badian).
  const url = /^https?:\/\//.test(raw) ? secure(raw) : null
  return { label: /consent|permission/i.test(raw) ? "By permission" : "Collection's own terms", url }
}

/** How the Sources page groups photo licences. */
export type LicenceGroup = "open" | "attribution" | "noncommercial" | "own" | "none"

export function licenceGroup(l: Licence | null): LicenceGroup {
  if (!l) return "none"
  if (/^(CC0|Public domain)$/.test(l.label)) return "open"
  if (/^CC BY(-SA)? /.test(l.label)) return "attribution"
  if (/^CC BY-NC/.test(l.label)) return "noncommercial"
  return "own"
}

/** First clause of an OCRE description, for card titles: "Dacian seated left …; round him …" → "Dacian seated left …". */
export function shortDescription(text: string | null | undefined): string | null {
  if (!text) return null
  return text.split(/;\s/)[0].trim()
}

/*
 * A legend cleaned to stand in for a missing photograph, as lines, or null when it can't.
 * Catalogue notation goes: the first of "A or B", cataloguer's notes "(in exergue)", break
 * hyphens, restoration brackets and gaps ("[...]"). "//" or " / " (a new line on the coin) starts
 * a new line. Fragments under four letters ("S C") and long legends (over 60 characters) give null,
 * and the plinth shows only its note.
 */
export function plinthLegend(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  const text = raw
    .replace(/\s*\((?:or|in|on|at|to|below|above|around|across)\b[^)]*\)/gi, "")
    .split(/\s+or\s+/)[0]
  const lines = text
    .split(/\/\/|\s\/\s/)
    .map((l) =>
      l
        .replace(/[-_[\]{}()?*|\\←∈�]/g, "")
        .replace(/\.{2,}|…|\//g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
  const all = lines.join(" ")
  if ((all.match(/\p{L}/gu) ?? []).length < 4 || all.length > 60) return null
  return lines
}

/** Pronunciations in an extract: "The tetradrachm /ˈtetrəˌdræm/ was", "Rome (/roʊm/ ROHM)". */
const IPA = /\s*\(?\/[^/\s][^/]{0,40}\/(\s+[A-Z-]+)?\)?(?=[\s,;])/g

/** First sentences of an extract, up to about `max` characters, ending on a full stop. */
export function lead(text: string | null, max = 320): string | null {
  if (!text) return null
  // A sentence ends at a stop followed by a space and a capital, so "17.2 grams" and "2.7 million" stay whole.
  const sentences = text.replace(IPA, "").split(/(?<=[.!?])\s+(?=[A-Z"“‘(])/)
  let out = ""
  for (const s of sentences) {
    if (out && out.length + s.length + 1 > max) break
    out += (out ? " " : "") + s
  }
  return out.trim()
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* How dealers cite each catalogue, by reference_work id. RIC numbers restart for every ruler, so
 * a RIC search also needs the volume and the ruler; the others number their types uniquely. */
const DEALER_CITATION: Record<string, string> = {
  rrc: "Crawford",
  price1991: "Price",
  seleucid_coins: "SC",
  "svoronos-1904": "Svoronos",
}

/** ACSearch past-sales search for a type, by its catalogue citation (and ruler, for RIC); null for catalogues dealers don't cite. */
export function acsearchUrl(work: string | null, volume: string | null, number: string | null, ruler: string | null): string | null {
  if (!number) return null
  const term =
    work === "ric" ? [ruler, volume ?? "RIC", number].filter(Boolean).join(" ") : work && DEALER_CITATION[work] ? `${DEALER_CITATION[work]} ${number}` : null
  if (!term) return null
  return `https://www.acsearch.info/search.html?term=${encodeURIComponent(term)}&category=1-2-3-4-5-6-7-8&images=1`
}
