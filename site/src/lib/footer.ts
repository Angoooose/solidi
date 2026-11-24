/*
 * Data for the site footer: the totals under the wordmark, the collections to
 * link to, the sources and their licences, and when the data was built.
 *
 * Every page shows the footer, so the result is kept per Worker instance and only re-read when the
 * database's build time changes (checked at most once a minute, as in middleware.ts).
 */
import { getCategories, tree } from "@/lib/categories"
import { licence, secure } from "@/lib/format"
import { sections } from "@/lib/summary/store"

export const GITHUB_URL = "https://github.com/Angoooose/solidi"
export const CONTACT_EMAIL = "contact@solidi.org"
/* The downloadable database: GitHub releases made by `solidi release --publish`. */
export const DOWNLOAD = {
  file: `${GITHUB_URL}/releases/latest/download/solidi.sqlite.gz`,
  releases: `${GITHUB_URL}/releases`,
  licenceUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
}
export const NOMISMA = { label: "Nomisma.org", url: "https://nomisma.org/", licence: "CC BY 4.0" }

/* How a corpus is named in the credit line where its slug isn't the usual short name. */
const SOURCE_LABELS: Record<string, string> = { cn: "Corpus Nummorum" }
/** A catalogue's short name: its slug in capitals (OCRE), or its usual name where that differs. */
export const sourceLabel = (slug: string) => SOURCE_LABELS[slug] ?? slug.toUpperCase()

export type FooterSource = { label: string; url: string | null }
export type FooterData = {
  /** Live types: not replaced, not a sub-variant (the collection pages count the same way). */
  types: number
  specimens: number
  collections: number
  /** Museums and collections that hold the specimens. */
  holders: number
  /** Top-level groups (Greek, Roman) and the collections under each. */
  groups: { id: string; name: string; collections: { id: string; name: string }[] }[]
  /** Sources by licence, in sources.yaml order: [{ licence: "ODbL", sources: [OCRE, CRRO…] }, …]. */
  licences: { licence: string; url: string | null; sources: FooterSource[] }[]
  builtAt: string | null
}

const BUILD_CHECK_MS = 60_000
let cached: { builtAt: string | null; checkedAt: number; data: Promise<FooterData> } | null = null

export async function getFooterData(db: D1Database): Promise<FooterData> {
  if (cached && Date.now() - cached.checkedAt < BUILD_CHECK_MS) return cached.data
  const row = await db.prepare(`SELECT value FROM build_info WHERE key = 'built_at'`).first<{ value: string }>()
  const builtAt = row?.value ?? null
  if (cached && cached.builtAt === builtAt) {
    cached.checkedAt = Date.now()
    return cached.data
  }
  const data = load(db, builtAt)
  cached = { builtAt, checkedAt: Date.now(), data }
  data.catch(() => { cached = null })
  return data
}

async function load(db: D1Database, builtAt: string | null): Promise<FooterData> {
  const [categories, counts, datasets, corpora] = await Promise.all([
    getCategories(db),
    sections(db, "totals", "site").then((s) => s.totals),
    db
      .prepare(`SELECT id, slug, data_licence AS licence FROM dataset WHERE slug IS NOT NULL`)
      .all<{ id: string; slug: string; licence: string | null }>(),
    db.prepare(`SELECT value FROM build_info WHERE key = 'corpora'`).first<{ value: string }>(),
  ])

  const t = tree(categories)
  const tops = t.children(null)
  const groups = tops.map((g) => ({
    id: g.id,
    name: g.name,
    collections: t.leaves(g.id).map((c) => ({ id: c.id, name: c.name })),
  }))

  // Group the corpora by licence, keeping the build's corpus order within and between groups.
  const order = (corpora?.value ?? "").split(",")
  const rank = (slug: string) => (order.indexOf(slug) + 1 || order.length + 1)
  const licences: FooterData["licences"] = []
  for (const d of [...datasets.results].sort((a, b) => rank(a.slug) - rank(b.slug))) {
    const l = licence(d.licence) ?? { label: "terms not stated", url: null }
    let group = licences.find((g) => g.licence === l.label)
    if (!group) licences.push((group = { licence: l.label, url: l.url, sources: [] }))
    group.sources.push({ label: sourceLabel(d.slug), url: secure(d.id) })
  }

  return {
    types: tops.reduce((n, c) => n + c.types, 0),
    specimens: counts?.specimens ?? 0,
    collections: groups.reduce((n, g) => n + g.collections.length, 0),
    holders: counts?.holders ?? 0,
    groups,
    licences,
    builtAt,
  }
}
