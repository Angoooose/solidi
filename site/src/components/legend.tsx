import * as React from "react"
import { cn } from "@/lib/utils"

/** One word or abbreviation of a legend, as stored in legend.segments. */
export type LegendSegment = {
  text: string
  latin?: string | null
  english?: string | null
  kind?: string
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
 * Interlinear gloss (coin-type page). Three aligned tiers per word:
 *   as struck  Latin capitals (text-latin)
 *   a hairline across the side
 *   Latin      Geist body, supplied letters in stone
 *   English    Garamond italic, wraps at 13ch
 * Scrolls sideways when it doesn't fit, fading at the edge with more to see.
 */
export function LegendGloss({ segments, className }: { segments: LegendSegment[]; className?: string }) {
  return (
    // shadcn's scroll-fade-x: fades whichever edge has more to scroll to, and none at the ends.
    <div className={cn("scroll-fade-x scroll-fade-16 scrollbar-thin overflow-x-auto pb-2", className)} tabIndex={0} aria-label="Legend, word by word">
      <div
        className="grid w-max items-baseline gap-x-8 pr-16"
        style={{ gridTemplateColumns: `repeat(${segments.length}, max-content)` }}
      >
        {segments.map((s, i) => (
          <span key={`c${i}`} className="font-serif text-latin whitespace-nowrap">
            {s.text}
          </span>
        ))}
        <div className="col-span-full mt-3 h-px bg-hairline" />
        {segments.map((s, i) => (
          <span key={`l${i}`} className="pt-3 whitespace-nowrap">
            {s.latin ? splitSupplied(s.text, s.latin) : <span className="text-stone">unexplained</span>}
          </span>
        ))}
        {segments.map((s, i) => (
          <span key={`e${i}`} className="max-w-[13ch] pt-1 font-serif text-[18px] leading-snug text-graphite italic">
            {s.english}
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
