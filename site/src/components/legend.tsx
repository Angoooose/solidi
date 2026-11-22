import * as React from "react"
import { cn } from "@/lib/utils"

/** One word or abbreviation of a legend, as stored in legend.segments. */
export type LegendSegment = {
  text: string
  latin?: string | null
  english?: string | null
  kind?: string
  /** person.id of the ruler a name or epithet refers to. */
  person?: string | null
  /** Where on the side the word sits, when the source says: 'exergue', 'left field'. */
  place?: string | null
}

/*
 * Split an expansion into struck and supplied letters: "IMP" + "Imperatori" → Imp|eratori.
 * Letters of the abbreviation are matched in order; everything else was supplied by the reader.
 */
function splitSupplied(abbr: string, latin: string): React.ReactNode[] {
  const want = abbr.replace(/\s+/g, "").toLowerCase()
  const out: React.ReactNode[] = []
  let i = 0
  let run = ""
  let runSupplied = false
  const flush = () => {
    if (!run) return
    out.push(runSupplied ? <span key={out.length} className="text-stone">{run}</span> : run)
    run = ""
  }
  for (const ch of latin) {
    const struck = i < want.length && ch.toLowerCase() === want[i]
    if (struck) i++
    const supplied = !struck && ch !== " "
    if (supplied !== runSupplied && ch !== " ") {
      flush()
      runSupplied = supplied
    }
    run += ch
  }
  flush()
  return out
}

/*
 * Greek in Latin letters, as a reader would say it: "Βασιλέως" → "basileōs", "Πτολεμαίου" →
 * "ptolemaiou". Long vowels keep their macrons; a rough breathing is an h.
 */
const GREEK: Record<string, string> = {
  α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "ē", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x",
  ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", ϲ: "s", τ: "t", υ: "y", φ: "ph", χ: "ch", ψ: "ps", ω: "ō", ϝ: "w",
}
const DIPHTHONG = /(?<=[αεηο])υ/g

export function sayGreek(word: string): string {
  return word
    .normalize("NFD")
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => {
      const rough = /^[^\u0300-\u036f]*?[\u0314]/.test(w.slice(0, 3)) || w.startsWith("ῥ")
      const bare = w.replace(/[\u0300-\u036f]/g, "").replace(DIPHTHONG, "u")
      const out = [...bare].map((ch, i, all) => (ch === "γ" && /[γκξχ]/.test(all[i + 1] ?? "") ? "n" : (GREEK[ch] ?? ch))).join("")
      return rough ? (out.startsWith("r") ? "rh" + out.slice(1) : "h" + out) : out
    })
    .join("")
}

/* Each place on a side, as the row label above its words. */
const PLACE_LABEL: Record<string, string> = {
  around: "Around",
  exergue: "In exergue",
  field: "In the field",
  "exergue or field": "In exergue or field",
  "left field": "Left field",
  "right field": "Right field",
}

/*
 * Language tags for a gloss's columns. Gandhari, Lycian and Carian segments are transliterated
 * words, so they read left to right in Latin letters (the original script is shown above them).
 */
const GLOSS_LANG: Record<string, { text: string; tracked: boolean; reading: string }> = {
  la: { text: "la", tracked: true, reading: "Written out" },
  grc: { text: "grc", tracked: true, reading: "Say it" },
  pgd: { text: "pgd-Latn", tracked: false, reading: "Reading" },
  xlc: { text: "xlc-Latn", tracked: false, reading: "Reading" },
  xcr: { text: "xcr-Latn", tracked: false, reading: "Reading" },
}

const COLUMNS = "grid grid-cols-2 gap-x-6 sm:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]"

/*
 * A side's legend, one row per word (coin-type page): as struck in capitals, written
 * out (Latin, supplied letters in stone) or said (Greek, in Latin letters), and what it means.
 * Words in a named place on the side (exergue, left field) sit under that place's label. On phones
 * the struck word takes its own line above the other two.
 */
export function LegendTable({
  segments,
  language = "la",
  rulers,
}: {
  segments: LegendSegment[]
  language?: string | null
  /** person ids with a ruler page; segments naming anyone else are not linked. */
  rulers?: ReadonlySet<string>
}) {
  const code = language ?? "la"
  const lang = GLOSS_LANG[code] ?? GLOSS_LANG.la
  const linked = (s: LegendSegment, node: React.ReactNode) =>
    s.person && rulers?.has(s.person) ? (
      <a href={`/person/${s.person}`} className="underline-offset-4 hover:underline">
        {node}
      </a>
    ) : (
      node
    )
  const reading = (s: LegendSegment): React.ReactNode =>
    code === "la" ? (s.latin ? splitSupplied(s.text, s.latin) : s.text) : code === "grc" ? sayGreek(s.latin ?? s.text) : (s.latin ?? s.text)
  const placed = segments.some((s) => s.place)
  return (
    <div className="flex min-w-0 flex-col" lang={lang.text}>
      <div lang="en" className={cn(COLUMNS, "hidden pb-2 text-label text-stone sm:grid")}>
        <span>On the coin</span>
        <span>{lang.reading}</span>
        <span>Meaning</span>
      </div>
      {segments.map((s, i) => {
        const place = placed && s.place !== segments[i - 1]?.place ? (s.place ?? null) : undefined
        return (
          <React.Fragment key={i}>
            {place !== undefined && (
              <div lang="en" className="border-t border-hairline pt-3.5 pb-0.5 text-label text-stone">
                {place ? PLACE_LABEL[place] ?? place : "Also on this side"}
              </div>
            )}
            <div className={cn(COLUMNS, "items-baseline py-3", place === undefined && "border-t border-hairline")}>
              <span className={cn("col-span-full pb-1 font-serif text-[1.25rem] [overflow-wrap:anywhere] sm:col-span-1 sm:pb-0", lang.tracked && "tracking-[0.12em]")}>
                {linked(s, s.text)}
              </span>
              <span lang={code === "la" ? "la" : "en"} className="text-body break-words">
                {reading(s)}
              </span>
              <span lang="en" className="font-serif text-[1.1875rem] leading-snug text-graphite italic">
                {s.english && linked(s, s.english)}
              </span>
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

/* A legend in Latin capitals (24/1.3, +12% tracking). */
export function Legend({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("m-0 font-serif text-latin", className)}>{children}</p>
}

/*
 * legend.language codes and how to mark them up. Kharoshthi (Gandhari on Indo-Greek reverses)
 * and Phoenician run right to left; 'zxx' is a cataloguer's note ("Illegible inscription"), not a legend.
 */
const SCRIPTS: Record<string, { lang: string; dir?: "rtl"; tracked: boolean }> = {
  la: { lang: "la", tracked: true },
  grc: { lang: "grc", tracked: true },
  pgd: { lang: "pgd", dir: "rtl", tracked: false },
  phn: { lang: "phn", dir: "rtl", tracked: false },
  pra: { lang: "pra", tracked: false },
  xlc: { lang: "xlc", tracked: false },
  xcr: { lang: "xcr", tracked: false },
}

/** Kharoshthi, Phoenician, Brahmi, Lycian or Carian letters: the page needs the Noto fonts for them (Base.astro `scripts`). */
export const NEEDS_SCRIPT_FONTS = /[\u{10280}-\u{102DF}\u{10900}-\u{1091F}\u{10A00}-\u{10A5F}\u{11000}-\u{1107F}]/u

/*
 * A legend in any language, without a word-by-word gloss: the text as struck, in its own script
 * and direction, with a Latin-letter transliteration beneath in stone when there is one.
 */
export function LegendText({
  legend,
  language,
  transliteration,
  className,
}: {
  legend: string
  language: string | null
  transliteration?: string | null
  className?: string
}) {
  if (language === "zxx") return <p className={cn("m-0 font-serif text-reading text-stone italic", className)}>{legend}</p>
  const script = SCRIPTS[language ?? "la"]
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p
        lang={script?.lang ?? language ?? undefined}
        dir={script?.dir}
        className={cn("legend-script m-0 w-fit text-latin", script && !script.tracked && "tracking-normal")}
      >
        {legend}
      </p>
      {transliteration && (
        <p className="m-0 font-serif text-[18px] leading-snug text-stone italic">
          <span className="sr-only">Transliteration: </span>
          {transliteration}
        </p>
      )}
    </div>
  )
}

/*
 * Legend line in a search result: small stone capitals with the matched run in ink on the plinth.
 * Pass the full legend and the matched substring.
 */
export function LegendMatch({ legend, match }: { legend: string; match?: string }) {
  const at = match ? legend.toUpperCase().indexOf(match.toUpperCase()) : -1
  return (
    <span className="font-serif text-body tracking-[0.06em] text-stone">
      {at < 0 ? (
        legend
      ) : (
        <>
          {legend.slice(0, at)}
          <b className="bg-plinth px-0.5 font-normal text-ink">{legend.slice(at, at + match!.length)}</b>
          {legend.slice(at + match!.length)}
        </>
      )}
    </span>
  )
}
