/*
 * Page titles and descriptions for search results and link previews (layouts/Base.astro).
 * Each is one factual sentence built from what the page already loaded, about 160 characters at
 * most. A count is left out on a filtered view (any query string), since the page's total is then
 * the filtered one and the description speaks for the whole page.
 */
import { fmt } from "@/lib/categories"
import { shortDescription } from "@/lib/format"

/** Search engines cut descriptions at about this length. */
const MAX = 160

/** `text` cut at a word boundary to `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "")}…`
}

const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`)

/* Words a reverse label never ends on. */
const DANGLING = /\s+(and|or|of|on|in|at|with|to|the|a|an|from|by|before|behind|between|above|below|under)$/i
/* Where a reverse description turns from what is shown to its details. */
const DETAIL = /\s+(?:holding|with|wearing|resting|raising|bearing|decorated|inscribed|in which|containing|within|on|in|before|between)\s/i
/* A figure's pose ends at its direction: "Dacian seated left | on a pile of arms". */
const FACING = /^(.*?\b(?:left|right|facing|front))\b/i

/**
 * A short name for a reverse design, for titles: "Victory standing left, holding wreath and palm"
 * → "Victory standing left". The first clause, then its first comma part; when that is too long,
 * up to the figure's direction, else up to its details; null when nothing short enough is left.
 */
export function reverseLabel(description: string | null | undefined, max = 40): string | null {
  let s = shortDescription(description)?.split(/\.\s/)[0].replace(/\.$/, "").trim()
  if (!s) return null
  s = s.split(/,\s/)[0]
  if (s.length > max) {
    const pose = s.match(FACING)?.[1]
    s = pose && pose.length <= max ? pose : s.split(DETAIL)[0]
  }
  if (s.length > max) {
    s = s.slice(0, max + 1)
    s = s.slice(0, s.lastIndexOf(" "))
  }
  while (DANGLING.test(s)) s = s.replace(DANGLING, "")
  return s.length >= 3 && !/^blank$/i.test(s) ? s : null
}

/**
 * A coin type's title: "Trajan denarius, Dacian seated left · RIC II Trajan 98". Whoever struck it
 * (else its mint) and its denomination, then the reverse, then the catalogue reference. The reverse
 * is dropped when the title would run long.
 */
export function typeTitle(t: {
  reference: string
  who: string | null
  denomination: string | null
  reverse: string | null
}): string {
  const coin = [t.who, t.denomination ?? (t.who ? "coin" : null)].filter(Boolean).join(" ")
  if (!coin) return t.reference
  const base = `${coin} · ${t.reference}`
  // Titles past ~70 characters get cut in results; the reverse takes what room is left.
  const room = Math.min(40, 70 - base.length - 2)
  const label = room >= 6 ? reverseLabel(t.reverse, room) : null
  // "Diocletian fraction, Diocletian" says nothing: the reverse shows the ruler again.
  const repeats = label && t.who && (label.toLowerCase().includes(t.who.toLowerCase()) || t.who.toLowerCase().includes(label.toLowerCase()))
  return label && !repeats ? `${coin}, ${label} · ${t.reference}` : base
}

/** "Silver denarius of Trajan, struck at Rome, AD 103–111. Reverse: Dacian seated left on a pile of arms … RIC II Trajan 98." */
export function typeDescription(t: { summary: string; reference: string; reverse: string | null }): string {
  const head = sentence(t.summary)
  const tail = ` ${sentence(t.reference)}`
  const reverse = shortDescription(t.reverse)?.replace(/\.$/, "")
  if (!reverse) return clip(head + tail, MAX)
  const room = MAX - head.length - tail.length - " Reverse: .".length
  return room >= 24 ? `${head} Reverse: ${sentence(clip(reverse, room))}${tail}` : clip(head + tail, MAX)
}

/** "Coins of Trajan (AD 98–117): 969 coin types in the Roman Imperial series." */
export function personDescription(p: { name: string; dates: string | null; total: number | null; collection: string | null }): string {
  const what = [p.total != null ? plural(p.total, "coin type") : "Coin types", p.collection && `in the ${p.collection} series`].filter(Boolean).join(" ")
  return clip(`Coins of ${p.name}${p.dates ? ` (${p.dates})` : ""}: ${what.charAt(0).toLowerCase() + what.slice(1)}.`, MAX)
}

/** "Coins struck at Rome, in Latium, 280 BC – AD 491: 47,748 coin types by 565 issuers." */
export function mintDescription(m: { name: string; region: string | null; dates: string | null; total: number | null; people: number }): string {
  const where = [`Coins struck at ${m.name}`, m.region && `in ${m.region}`, m.dates].filter(Boolean).join(", ")
  const what = [m.total != null && plural(m.total, "coin type"), m.people > 0 && `by ${plural(m.people, "issuer")}`].filter(Boolean).join(" ")
  return clip(what ? `${where}: ${what}.` : `${where}.`, MAX)
}

/** "The denarius, a silver coin, 211 BC – AD 300: 6,758 coin types from 120 mints." */
export function denominationDescription(d: { name: string; metal: string | null; dates: string | null; total: number | null; mints: number }): string {
  const name = d.name.charAt(0).toLowerCase() + d.name.slice(1)
  const head = [`The ${name}`, d.metal && `a ${d.metal.toLowerCase()} coin`, d.dates].filter(Boolean).join(", ")
  const what = [d.total != null && plural(d.total, "coin type"), d.mints > 0 && `from ${plural(d.mints, "mint")}`].filter(Boolean).join(" ")
  return clip(what ? `${head}: ${what}.` : `${head}.`, MAX)
}

/** "Victory on ancient coins, 300 BC – AD 491: 6,332 coin types, struck at 210 mints." */
export function subjectDescription(s: { name: string; dates: string | null; total: number | null; mints: number }): string {
  const head = [`${s.name} on ancient coins`, s.dates].filter(Boolean).join(", ")
  const what = [s.total != null && plural(s.total, "coin type"), s.mints > 0 && `struck at ${plural(s.mints, "mint")}`].filter(Boolean).join(", ")
  return clip(what ? `${head}: ${what}.` : `${head}.`, MAX)
}

/** "Roman Imperial coinage, 31 BC – AD 491: 40,000 coin types from 120 mints." */
export function collectionDescription(c: { name: string; dates: string | null; types: number; mints: number }): string {
  const head = [`${c.name} coinage`, c.dates].filter(Boolean).join(", ")
  const what = [c.types > 0 && plural(c.types, "coin type"), c.mints > 0 && `from ${plural(c.mints, "mint")}`].filter(Boolean).join(" ")
  return clip(what ? `${head}: ${what}.` : `${head}.`, MAX)
}
