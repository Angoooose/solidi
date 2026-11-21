/*
 * Data for the Sources page: the catalogues the types come from, the other
 * sources of concepts, text and maps, and the collections whose photographs we show, each under
 * its own terms. The photo counts come from photo_source (pipeline/summaries.py).
 */
import { imageLicence, licence, licenceGroup, secure, type Licence, type LicenceGroup } from "@/lib/format"
import { NOMISMA } from "@/lib/footer"

/* What the catalogues' own records don't say: who publishes each, what it covers, and a reader's name for it. */
const CATALOGUES: Record<string, { name?: string; publisher: string; covers: string }> = {
  ocre: { publisher: "American Numismatic Society", covers: "Roman Imperial" },
  iris: { publisher: "University of Oxford", covers: "Greek cities, Archaic to Hellenistic" },
  cn: { name: "Corpus Nummorum", publisher: "Berlin-Brandenburg Academy of Sciences", covers: "Thrace, Moesia, Mysia and the Troad" },
  pella: { publisher: "American Numismatic Society", covers: "Macedonian kings" },
  sco: { publisher: "American Numismatic Society", covers: "Seleucid kingdom" },
  pco: { publisher: "American Numismatic Society", covers: "Ptolemaic kingdom" },
  crro: { publisher: "American Numismatic Society", covers: "Roman Republic and the civil wars" },
  bigr: { name: "Bactrian and Indo-Greek Coinage", publisher: "American Numismatic Society", covers: "Bactria and north-west India" },
  agco: { publisher: "American Numismatic Society", covers: "Antigonid kings" },
}

/** A catalogue's full name for readers: "Bactrian and Indo-Greek Coinage", not its record's "BIGR". */
export const catalogueName = (slug: string, name: string) => CATALOGUES[slug]?.name ?? name

export const OTHER_SOURCES = {
  nomisma: { ...NOMISMA, licenceUrl: "https://creativecommons.org/licenses/by/4.0/" },
  wikipedia: { label: "Wikipedia", url: "https://en.wikipedia.org/", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" },
  naturalEarth: { label: "Natural Earth", url: "https://www.naturalearthdata.com/", licence: "Public domain", licenceUrl: "https://www.naturalearthdata.com/about/terms-of-use/" },
}

/* The licence groups, most open first, as the bar and its key show them. */
export const LICENCE_GROUPS: { id: LicenceGroup; label: string }[] = [
  { id: "open", label: "Public domain or CC0" },
  { id: "attribution", label: "CC BY or BY-SA" },
  { id: "noncommercial", label: "Non-commercial Creative Commons" },
  { id: "own", label: "The collection's own terms" },
  { id: "none", label: "No licence stated" },
]

export type Catalogue = { id: string; name: string; url: string | null; publisher: string | null; covers: string | null; types: number; licence: Licence | null }
export type Holder = { id: string; name: string; url: string | null; coins: number; licence: Licence | null }
export type Sources = {
  catalogues: Catalogue[]
  types: number
  /** Wikipedia introductions by kind of entity. */
  articles: { person: number; mint: number; subject: number; denomination: number }
  photographed: number
  images: number
  /** Photographed coins per licence group, in LICENCE_GROUPS order. */
  byLicence: { id: LicenceGroup; label: string; coins: number }[]
  holders: Holder[]
}

/* Some dataset titles carry markup for the source's own page: "Das Digitale Münzkabinett<br>der …". */
const clean = (s: string) => s.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim()

export async function getSources(db: D1Database): Promise<Sources> {
  const [catalogues, articles, photos] = await db.batch([
    // Live types, as the collection pages count them: not replaced, not a sub-variant.
    db.prepare(`SELECT d.slug, d.name, d.id AS url, d.data_licence, c.types
                FROM catalogue_stat c JOIN dataset d ON d.id = c.dataset_id WHERE d.slug IS NOT NULL ORDER BY c.types DESC`),
    db.prepare(`SELECT entity_type, count(*) AS n FROM article WHERE source = 'wikipedia_en' GROUP BY entity_type`),
    db.prepare(`SELECT p.institution_id, p.dataset_id, p.photographed, p.images, n.name AS holder, n.homepage,
                       d.name AS dataset, d.image_licence, d.data_licence
                FROM photo_source p JOIN dataset d ON d.id = p.dataset_id LEFT JOIN institution n ON n.id = p.institution_id`),
  ])

  const cats = (catalogues.results as { slug: string; name: string; url: string; data_licence: string | null; types: number }[]).map((c) => ({
    id: c.slug,
    name: catalogueName(c.slug, c.name),
    url: secure(c.url),
    publisher: CATALOGUES[c.slug]?.publisher ?? null,
    covers: CATALOGUES[c.slug]?.covers ?? null,
    types: c.types,
    licence: licence(c.data_licence),
  }))

  const counts = Object.fromEntries((articles.results as { entity_type: string; n: number }[]).map((r) => [r.entity_type, r.n]))

  type Row = {
    institution_id: string | null
    dataset_id: string
    photographed: number
    images: number
    holder: string | null
    homepage: string | null
    dataset: string
    image_licence: string | null
    data_licence: string | null
  }
  const rows = photos.results as Row[]
  const groups = new Map(LICENCE_GROUPS.map((g) => [g.id, 0]))
  // A holder's photos can come through more than one dataset (the Ashmolean's own, and SITNAM's
  // archive): its count is their sum, its licence that of the dataset giving most of them.
  const holders = new Map<string, Holder & { lead: number }>()
  for (const r of rows) {
    const l = imageLicence(r.image_licence, r.data_licence)
    const group = licenceGroup(l)
    groups.set(group, groups.get(group)! + r.photographed)
    const id = r.institution_id ?? r.dataset_id
    const h = holders.get(id)
    if (!h) {
      holders.set(id, {
        id,
        name: clean(r.holder ?? r.dataset),
        url: secure(r.institution_id ? r.homepage : r.dataset_id),
        coins: r.photographed,
        licence: l,
        lead: r.photographed,
      })
    } else {
      h.coins += r.photographed
      if (r.photographed > h.lead) Object.assign(h, { licence: l, lead: r.photographed })
    }
  }

  return {
    catalogues: cats,
    types: cats.reduce((n, c) => n + c.types, 0),
    articles: { person: counts.person ?? 0, mint: counts.mint ?? 0, subject: counts.subject ?? 0, denomination: counts.denomination ?? 0 },
    photographed: rows.reduce((n, r) => n + r.photographed, 0),
    images: rows.reduce((n, r) => n + r.images, 0),
    byLicence: LICENCE_GROUPS.map((g) => ({ ...g, coins: groups.get(g.id)! })),
    holders: [...holders.values()].sort((a, b) => b.coins - a.coins || a.name.localeCompare(b.name)).map(({ lead: _, ...h }) => h),
  }
}
