/*
 * Denomination pieces: a coin drawn at relative size, a row of them on a plinth ("The 9 most
 * struck, at relative size", the Size section), and the rows of the denominations list and of a
 * denomination's "Where it was struck".
 */
import * as React from "react"
import { cn } from "@/lib/utils"
import { yearRange } from "@/lib/format"
import type { Photo } from "@/lib/categories"
import { CollectionRow } from "@/components/collection"
import { DENOMINATION_BIN, sizeLine, type DenominationRow } from "@/lib/denominations"
import type { Bin } from "@/components/charts"

/** Pixels per millimetre for list thumbnails: a 32 mm sestertius is 53px, inside the 56px cell. */
const ROW_SCALE = 1.66
const ROW_MAX = 56
/** Unmeasured denominations are drawn as an outline at this size. */
const UNMEASURED_MM = 18

/** A coin photo at `px` across (times --coin-s, set smaller on phones), or a dashed outline where there is no photo. */
export function Coin({ photo, px, alt = "", className }: { photo: Photo | null; px: number; alt?: string; className?: string }) {
  const size = { width: `calc(${px}px * var(--coin-s, 1))`, height: `calc(${px}px * var(--coin-s, 1))` }
  const src = px > 110 ? photo?.large : (photo?.thumb ?? photo?.large)
  // A photo that fails becomes the dashed outline.
  return src ? (
    <span data-plinth="small" style={size} className={cn("relative block", className)}>
      <img src={src} alt={alt} loading="lazy" decoding="async" data-coin-photo className="block size-full object-contain mix-blend-multiply" />
      <span className="plinth-fallback absolute inset-0 rounded-full border border-dashed border-field" />
    </span>
  ) : (
    <span role={alt ? "img" : undefined} aria-label={alt || undefined} style={size} className={cn("block rounded-full border border-dashed border-field", className)} />
  )
}

/** The list's thumbnail: the coin at its median diameter, on one scale for every row. */
export function RowCoin({ photo, diameter }: { photo: Photo | null; diameter: number | null }) {
  const px = Math.min(ROW_MAX, Math.round((diameter ?? UNMEASURED_MM) * ROW_SCALE))
  return (
    <span className="flex h-11 w-11 items-center justify-center md:h-14 md:w-16">
      <Coin photo={diameter != null ? photo : null} px={px} className="max-md:scale-75" />
    </span>
  )
}

export type ScaleCoin = { id: string; name: string; diameter: number; photo: Photo | null; href?: string; current?: boolean }

/**
 * Coins side by side at relative size, largest first, on the plinth: the largest is `max` px
 * across. Names and diameters under each; `current` underlines the page's own.
 */
export function CoinScale({ coins, max, caption }: { coins: ScaleCoin[]; max: number; caption: string }) {
  const sorted = [...coins].sort((a, b) => b.diameter - a.diameter)
  const scale = max / Math.max(...sorted.map((c) => c.diameter))
  const tallest = Math.round(sorted[0].diameter * scale)
  return (
    <figure className="m-0">
      <div className="overflow-x-auto bg-plinth [--coin-s:0.55] md:[--coin-s:1]">
        <div className="mx-auto flex w-max items-end gap-5 px-5 pt-8 pb-6 md:gap-10 md:px-12 md:pt-12 md:pb-8">
          {sorted.map((c) => {
            const px = Math.round(c.diameter * scale)
            const body = (
              <>
                <span className="flex items-end" style={{ height: `calc(${tallest}px * var(--coin-s, 1))` }}>
                  <Coin photo={c.photo} px={px} alt={c.name} />
                </span>
                <span className="flex flex-col items-center gap-px">
                  <span
                    className={cn(
                      "font-serif text-[1.0625rem] leading-[1.15] decoration-1 underline-offset-4",
                      c.current ? "border-b border-ink pb-[3px] text-ink" : c.href ? "text-ink group-hover:underline" : "pb-1 text-stone"
                    )}
                  >
                    {c.name}
                  </span>
                  <span className="num text-label text-stone">{c.diameter} mm</span>
                </span>
              </>
            )
            return c.href ? (
              <a key={c.id} href={c.href} className="group flex flex-col items-center gap-3">
                {body}
              </a>
            ) : (
              <div key={c.id} aria-current={c.current || undefined} className="flex flex-col items-center gap-3">
                {body}
              </div>
            )
          })}
        </div>
      </div>
      <figcaption className="mt-3 text-label text-stone">{caption}</figcaption>
    </figure>
  )
}

/* A denomination in the list: coin, name and size, the collections it was struck in (or its dates), its histogram, its count. */
export function DenominationListRow({
  row,
  href,
  byDate,
  domain,
  ticks,
}: {
  row: DenominationRow
  href: string
  byDate: boolean
  domain: [number, number]
  ticks: number[]
}) {
  const dates = yearRange(row.start, row.end)
  const [first, ...rest] = row.collections
  return (
    <CollectionRow
      href={href}
      name={row.name}
      lead={<RowCoin photo={row.photo} diameter={row.diameter} />}
      dates={
        <>
          {sizeLine(row)}
          {dates && <span className="md:hidden">{sizeLine(row) ? " · " : ""}{dates}</span>}
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
      bins={row.bins}
      binWidth={DENOMINATION_BIN}
      domain={domain}
      ticks={ticks}
      count={row.n}
    />
  )
}

/* A collection in a denomination's "Where it was struck": name, dates, histogram, median weight, count. */
export function DenominationCollectionRow({
  href,
  name,
  dates,
  weight,
  ...chart
}: {
  href: string
  name: string
  dates: string | null
  weight: number | null
  bins: Bin[]
  domain: [number, number]
  ticks: number[]
  count: number
}) {
  return (
    <CollectionRow
      href={href}
      name={name}
      dates={<span className="md:hidden">{[dates, weight != null ? `${weight.toFixed(1)} g` : null].filter(Boolean).join(" · ")}</span>}
      aside={<span className="num text-ui text-ink">{dates}</span>}
      extra={weight != null ? <span className="num text-ui text-ink">{weight.toFixed(1)} g</span> : <span className="num text-ui text-stone">—</span>}
      binWidth={DENOMINATION_BIN}
      {...chart}
    />
  )
}
