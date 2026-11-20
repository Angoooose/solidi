/*
 * Subject pieces: a subject's row in the list (photo, "Zeus · Jupiter", Greek and Roman counts or
 * its collections, a histogram with Roman stacked over Greek, its count), the key to those two
 * series, and the places grid.
 */
import * as React from "react"
import { CollectionRow } from "@/components/collection"
import { fmt } from "@/lib/categories"
import { yearRange } from "@/lib/format"
import { SUBJECT_BIN, type SubjectRow } from "@/lib/subjects"

/* `byDate`: in one leaf collection, where naming the collection would repeat on every row. */
export function SubjectListRow({ row, href, byDate = false, domain, ticks }: { row: SubjectRow; href: string; byDate?: boolean; domain: [number, number]; ticks: number[] }) {
  const [first, ...rest] = row.collections
  const line = byDate
    ? yearRange(row.start, row.end)
    : row.paired && row.greek > 0 && row.roman > 0
      ? `Greek ${fmt(row.greek)} · Roman ${fmt(row.roman)}`
      : first
        ? `${first.name}${rest.length ? ` · ${rest.length} more` : ""}`
        : null
  return (
    <CollectionRow
      href={href}
      photo={row.photo}
      name={row.names.join(" · ")}
      dates={line}
      bins={row.bins}
      binWidth={SUBJECT_BIN}
      domain={domain}
      ticks={ticks}
      count={row.n}
    />
  )
}

/** "■ Greek collections ■ Roman collections": the two series of a row's histogram. */
export function GreekRomanKey() {
  return (
    <span className="flex flex-wrap gap-x-5 gap-y-1 text-label text-stone">
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-ink" />
        Greek collections
      </span>
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-[color-mix(in_srgb,var(--color-stone)_45%,white)]" />
        Roman collections
      </span>
    </span>
  )
}

/** Places as a grid of names and counts, filled down each column. */
export function PlacesGrid({ rows, href }: { rows: SubjectRow[]; href: (id: string) => string }) {
  return (
    <div className="grid grid-cols-2 gap-x-8 md:grid-flow-col md:grid-cols-4 md:grid-rows-(--rows) md:gap-x-14" style={{ "--rows": `repeat(${Math.ceil(rows.length / 4)}, auto)` } as React.CSSProperties}>
      {rows.map((r) => (
        <a key={r.id} href={href(r.id)} className="group flex items-baseline justify-between gap-3 border-b border-hairline py-2.5 text-ui text-ink">
          <span className="truncate underline-offset-4 group-hover:underline">{r.names.join(" · ")}</span>
          <span className="num text-label text-stone">{fmt(r.n)}</span>
        </a>
      ))}
    </div>
  )
}
