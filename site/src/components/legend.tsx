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
 * Language tags for a gloss's tiers. Gandhari segments are transliterated words, so the gloss
 * runs left to right in Latin letters (the Kharoshthi original is shown above it, right to left).
 */
const GLOSS_LANG: Record<string, { text: string; reading: string | undefined; tracked: boolean }> = {
  la: { text: "la", reading: "la", tracked: true },
  grc: { text: "grc", reading: "grc", tracked: true },
  pgd: { text: "pgd-Latn", reading: undefined, tracked: false },
}

/*
 * Interlinear gloss (coin-type page). Three aligned tiers per word:
 *   as struck  capitals (text-latin): Latin, Greek, or a Gandhari transliteration
 *   a hairline across the side
 *   reading    Geist body: the Latin written out, supplied letters in stone; accented Greek;
 *              the Gandhari form with its Greek equivalent
 *   English    Garamond italic, wraps at 13ch
 * Words naming a ruler link to their page when `rulers` holds that person.
 * Scrolls sideways when it doesn't fit, fading at the edge with more to see.
 */
export function LegendGloss({
  segments,
  language = "la",
  rulers,
  className,
}: {
  segments: LegendSegment[]
  language?: string | null
  /** person ids with a ruler page; segments naming anyone else are not linked. */
  rulers?: ReadonlySet<string>
  className?: string
}) {
  const lang = GLOSS_LANG[language ?? "la"] ?? GLOSS_LANG.la
  const latin = (language ?? "la") === "la"
  const linked = (s: LegendSegment, node: React.ReactNode) =>
    s.person && rulers?.has(s.person) ? (
      <a href={`/ruler/${s.person}`} className="underline-offset-4 hover:underline">
        {node}
      </a>
    ) : (
      node
    )
  return (
    // shadcn's scroll-fade-x: fades whichever edge has more to scroll to, and none at the ends.
    <div
      className={cn("scroll-fade-x scroll-fade-16 scrollbar-thin overflow-x-auto pb-2", className)}
      tabIndex={0}
      aria-label="Legend, word by word"
      dir="ltr"
    >
      <div
        className="grid w-max items-baseline gap-x-8 pr-16"
        style={{ gridTemplateColumns: `repeat(${segments.length}, max-content)` }}
      >
        {segments.map((s, i) => (
          <span key={`c${i}`} lang={lang.text} className={cn("font-serif text-latin whitespace-nowrap", !lang.tracked && "tracking-normal")}>
            {linked(s, s.text)}
          </span>
        ))}
        <div className="col-span-full mt-3 h-px bg-hairline" />
        {segments.map((s, i) => (
          <span key={`l${i}`} lang={lang.reading} className="pt-3 whitespace-nowrap">
            {s.latin ? (latin ? splitSupplied(s.text, s.latin) : s.latin) : <span className="text-stone">unexplained</span>}
          </span>
        ))}
        {segments.map((s, i) => (
          <span key={`e${i}`} lang="en" className="max-w-[13ch] pt-1 font-serif text-[18px] leading-snug text-graphite italic">
            {s.english && linked(s, s.english)}
          </span>
        ))}
      </div>
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
}

/** Kharoshthi, Phoenician or Brahmi letters: the page needs the Noto fonts for them (Base.astro `scripts`). */
export const NEEDS_SCRIPT_FONTS = /[\u{10900}-\u{1091F}\u{10A00}-\u{10A5F}\u{11000}-\u{1107F}]/u

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
