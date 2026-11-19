/*
 * A mint in the mints list: the dense CollectionRow with the region under the name (and its dates,
 * on phones), and beside it the collections it struck for, or its dates when listed by date.
 */
import * as React from "react"
import { yearRange } from "@/lib/format"
import { CollectionRow } from "@/components/collection"
import { MINT_BIN, type MintRow } from "@/lib/mints"

export function MintListRow({
  mint,
  href,
  byDate,
  domain,
  ticks,
}: {
  mint: MintRow
  href: string
  byDate: boolean
  domain: [number, number]
  ticks: number[]
}) {
  const dates = yearRange(mint.start, mint.end)
  const [first, ...rest] = mint.collections
  return (
    <CollectionRow
      href={href}
      name={mint.name}
      dates={
        <>
          {mint.region ?? "Region unknown"}
          {dates && <span className="md:hidden"> · {dates}</span>}
        </>
      }
      aside={
        byDate ? (
          <span className="num text-ui text-ink">{dates}</span>
        ) : (
          <span className="block truncate text-label text-graphite">
            {first?.name}
            {rest.length > 0 && <span className="text-stone"> · {rest.length} more</span>}
          </span>
        )
      }
      bins={mint.bins}
      binWidth={MINT_BIN}
      domain={domain}
      ticks={ticks}
      count={mint.n}
    />
  )
}

/* A collection on the mint page's "Over time": name, its dates there, its histogram, its count. */
export function MintCollectionRow({
  href,
  name,
  dates,
  ...chart
}: {
  href: string
  name: string
  dates: string | null
  bins: MintRow["bins"]
  domain: [number, number]
  ticks: number[]
  yMax: number
  count: number
}) {
  return (
    <CollectionRow
      href={href}
      name={name}
      dates={<span className="md:hidden">{dates}</span>}
      aside={<span className="num text-ui text-ink">{dates}</span>}
      binWidth={MINT_BIN}
      {...chart}
    />
  )
}
