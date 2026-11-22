/*
 * Search text, as the ⌘K palette reads it. Pure functions, shared by the browser (matching people,
 * mints, collections, denominations and subjects) and the server (the catalogue-number index).
 *
 * tokens() must split text exactly as pipeline/search.py tokens() does: keep the two in step.
 */

/** "RIC II, Part 3 (second edition)" -> ["ric", "ii", "part", "3", ...]: lower case, no accents;
 *  letters, digits, and "." or "/" inside a number ("494/23", "2.3"). */
export function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9./]+/g, " ")
    .split(" ")
    .map((t) => t.replace(/^[./]+|[./]+$/g, ""))
    .filter(Boolean)
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }

/** The query names a catalogue number: it ends in one ("RIC II 22", "trajan 2", "rrc 494/2"). */
export function asksForNumber(q: string): boolean {
  const ts = tokens(q)
  const last = ts.at(-1)
  // A bare number is too broad, except a slashed one ("494/23" is only ever Crawford).
  return !!last && /\d/.test(last) && (ts.length > 1 || last.includes("/"))
}

/**
 * An FTS5 query for type_search: every word but the last must appear (a word as a prefix, a number
 * whole, a Roman numeral in either form), and the last is the start of the catalogue number.
 * Null when the query doesn't end in a number. Tokens hold only [a-z0-9./], so quoting is safe.
 */
export function typeMatch(q: string): { match: string; num: string } | null {
  if (!asksForNumber(q)) return null
  const ts = tokens(q)
  const num = ts.pop()!
  const terms = ts.map((t) => {
    if (t in ROMAN) return `(terms:"${t}" OR terms:"${ROMAN[t]}")`
    const part = t.match(/^([ivx]+)\.(\d+)$/) // "ii.3" -> RIC II, Part 3
    if (part && part[1] in ROMAN) return `terms:"${ROMAN[part[1]]}.${part[2]}"`
    return /\d/.test(t) ? `terms:"${t}"` : `terms:"${t}"*`
  })
  return { match: [...terms, `num:"${num}"*`].join(" AND "), num }
}

/** The words of a query that can name a person, mint or collection: not numbers or numerals. */
export function nameWords(q: string): string[] {
  return tokens(q).filter((t) => !/\d/.test(t) && !(t in ROMAN && asksForNumber(q)))
}

/* Lower case, no accents, words split on anything else: how names are compared. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
}

/**
 * How well a name matches: 2 it starts with the query, 1 every word starts a word of it, else 0.
 * Not letters mid-word: "rome" shouldn't find Tauromenium.
 */
export function nameScore(name: string, words: string[]): number {
  if (!words.length) return 0
  const n = fold(name)
  if (n.startsWith(words.join(" "))) return 2
  const parts = n.split(/[^a-z0-9]+/)
  return words.every((w) => parts.some((p) => p.startsWith(w))) ? 1 : 0
}
