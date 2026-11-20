/*
 * Charts for the collection pages: server-rendered SVG and HTML, no client JavaScript. Hover is
 * CSS (a bar darkens); tooltips come from `data-tip` attributes, shown by scripts/tooltip.ts.
 *
 * Years are historical (no year 0: -1 is 1 BC, 1 is AD 1). An axis tick at 0 reads "AD 1".
 */
import * as React from "react"
import { scaleLinear } from "d3-scale"
import { cn } from "@/lib/utils"
import { year, yearRange } from "@/lib/format"
import { fmt } from "@/lib/categories"

/** A histogram bin. `m`: a second series stacked above `n` in grey (subjects: Roman over Greek). */
export type Bin = { start: number; n: number; m?: number }

export const tickLabel = (y: number) => (y === 0 ? "AD 1" : year(y))

/** Tick years every `step` (50, 100, 200…) inside [from, to]. */
export function yearTicks([from, to]: [number, number], step: number): number[] {
  const out = []
  for (let y = Math.ceil(from / step) * step; y <= to; y += step) out.push(y)
  return out
}

/** A step giving about `target` ticks over the span. */
export function niceStep([from, to]: [number, number], target = 6): number {
  const raw = (to - from) / target
  return [10, 25, 50, 100, 200, 250, 500].find((s) => s >= raw) ?? 1000
}

const binRange = (start: number, width: number) => (start === 0 ? yearRange(1, width - 1) : yearRange(start, start + width - 1))
/** "48 types"; a bin can hold a share of a type spread over several bins. */
const typeCount = (n: number) => (n < 0.5 ? "under 1 type" : `${fmt(n)} ${Math.round(n) === 1 ? "type" : "types"}`)

/** "320–311 BC · 48 types": a bin's tooltip. */
export function binLabel(start: number, width: number, n: number): string {
  return `${binRange(start, width)} · ${typeCount(n)}`
}

/**
 * A stacked bin's tooltip: each series it holds by its swatch, and the total when it holds both
 * (scripts/tooltip.ts, data-tip-rich). `tip` is the plain-text form.
 */
function stackedTip(b: Bin, width: number, series: [string, string]): { tip: string; rich: string } {
  const m = b.m ?? 0
  const rows = [
    ...(b.n > 0 || m === 0 ? [["series", series[0], typeCount(b.n)]] : []),
    ...(m > 0 ? [["series-alt", series[1], typeCount(m)]] : []),
  ]
  return {
    tip: `${binLabel(b.start, width, b.n + m)} (${rows.map(([, name, count]) => `${name} ${count}`).join(", ")})`,
    rich: JSON.stringify({ title: binRange(b.start, width), rows, ...(rows.length > 1 ? { foot: `${typeCount(b.n + m)} in all` } : {}) }),
  }
}

/* Each type is spread evenly over its possible dates, so a bin can hold a fraction of one. */
const BAR_GAP = 0.08

/**
 * A row's sparkline (collection lists): 720×40 (or `height`), stretched to the column. Shared `domain` and
 * `yMax` across rows so heights and positions compare. Bars are at least 2px so a bin with a
 * single type still shows.
 */
export function Sparkline({
  bins,
  binWidth,
  domain,
  yMax,
  ticks,
  label,
  height = 40,
  series,
  className,
}: {
  bins: Bin[]
  binWidth: number
  domain: [number, number]
  yMax: number
  ticks: number[]
  label: string
  height?: number
  /** Names for a stacked histogram's two series (`n`, then `m` above it), for the tooltips. */
  series?: [string, string]
  className?: string
}) {
  const W = 720, H = height, TOP = 4
  const x = scaleLinear().domain(domain).range([0, W])
  const y = scaleLinear().domain([0, yMax]).range([0, H - TOP])
  const bw = x(domain[0] + binWidth) - x(domain[0])
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={label} className={cn("chart block overflow-visible", className)}>
      {ticks.map((t) => (
        <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={H} className="stroke-hairline" vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-field" vectorEffect="non-scaling-stroke" />
      {bins.map((b) => {
        const bx = x(b.start) + bw * BAR_GAP / 2
        const w = bw * (1 - BAR_GAP)
        const h = b.n > 0 || !b.m ? Math.max(2, y(b.n)) : 0
        const h2 = b.m ? Math.max(2, y(b.m)) : 0
        const { tip, rich } = series && b.m != null ? stackedTip(b, binWidth, series) : { tip: binLabel(b.start, binWidth, b.n + (b.m ?? 0)), rich: undefined }
        return (
          <React.Fragment key={b.start}>
            {h > 0 && <rect x={bx} width={w} y={H - h} height={h} rx={1.5} data-tip={tip} data-tip-rich={rich} className="bar" />}
            {h2 > 0 && <rect x={bx} width={w} y={H - h - h2} height={h2} rx={1.5} data-tip={tip} data-tip-rich={rich} className="bar bar-alt" />}
          </React.Fragment>
        )
      })}
    </svg>
  )
}

/** Year labels above or below a chart, placed at the same percentages as its ticks. */
export function YearAxis({ domain, ticks, className }: { domain: [number, number]; ticks: number[]; className?: string }) {
  const pct = (t: number) => ((t - domain[0]) / (domain[1] - domain[0])) * 100
  return (
    <span aria-hidden="true" className={cn("relative block h-[18px]", className)}>
      {ticks.map((t) => (
        <span key={t} className="num absolute -translate-x-1/2 text-label whitespace-nowrap text-stone" style={{ left: `${pct(t)}%` }}>
          {tickLabel(t)}
        </span>
      ))}
    </span>
  )
}

/**
 * The full histogram on a collection page ("Types by decade"): bars with horizontal gridlines,
 * count labels on the right and year labels below.
 */
export function Histogram({ bins, binWidth, label }: { bins: Bin[]; binWidth: number; label: string }) {
  if (!bins.length) return null
  const W = 1280, H = 200, TOP = 12
  const domain: [number, number] = [bins[0].start, bins[bins.length - 1].start + binWidth]
  const max = Math.max(...bins.map((b) => b.n))
  const y = scaleLinear().domain([0, max]).nice(5).range([H, TOP])
  const yTicks = y.ticks(5).filter((t) => t > 0)
  const x = scaleLinear().domain(domain).range([0, W])
  const bw = x(domain[0] + binWidth) - x(domain[0])
  const ticks = yearTicks(domain, niceStep(domain))
  const pct = (v: number) => `${(y(v) / H) * 100}%`
  return (
    <div>
      <div className="grid grid-cols-[1fr_40px] gap-3">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={label} className="chart block overflow-visible">
          {yTicks.map((t) => (
            <line key={t} x1={0} x2={W} y1={y(t)} y2={y(t)} className="stroke-hairline" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-ink" vectorEffect="non-scaling-stroke" />
          {bins.map((b) => (
            <rect key={b.start} x={x(b.start) + bw * BAR_GAP / 2} width={bw * (1 - BAR_GAP)} y={y(b.n)} height={H - y(b.n)} rx={2} data-tip={binLabel(b.start, binWidth, b.n)} className="bar" />
          ))}
        </svg>
        <span aria-hidden="true" className="relative">
          {yTicks.map((t) => (
            <span key={t} className="num absolute -translate-y-1/2 text-label text-stone" style={{ top: pct(t) }}>
              {fmt(t)}
            </span>
          ))}
        </span>
      </div>
      <YearAxis domain={domain} ticks={ticks} className="mt-2 mr-[52px]" />
    </div>
  )
}

/*
 * One person on a shared year axis (the people list), in three layers:
 * - lived: a hairline from birth to death, capped at each end (clipped at the axis's edges)
 * - coins: a pale band over every year their coins may date to
 * - office: an ink bar over their reign or magistracy, on top
 * The coins band shows wherever it runs past the office: coins struck before taking the title
 * (joint reigns) or in their name after death.
 */
export function PersonTrack({
  office,
  coins,
  lived,
  domain,
  tip,
  richTip,
}: {
  office: [number, number] | null
  coins: [number, number] | null
  lived: [number, number] | null
  domain: [number, number]
  tip: string | null
  /** The tooltip as a card with swatches (scripts/tooltip.ts, RichTip). */
  richTip?: { title: string; rows: [string, string, string][]; foot?: string }
}) {
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - domain[0]) / (domain[1] - domain[0])) * 100))
  const box = ([s, e]: [number, number]) => ({ left: `${pct(s)}%`, width: `${Math.max(0.5, pct(e + 1) - pct(s))}%` })
  // A lifetime wholly off the axis (an early moneyer on a list that starts later) isn't drawn.
  if (lived && (lived[1] < domain[0] || lived[0] > domain[1])) lived = null
  return (
    <span className="group/track relative block h-6" data-tip={tip ?? undefined} data-tip-rich={richTip ? JSON.stringify(richTip) : undefined}>
      {lived && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 h-px bg-stone/60",
            lived[0] >= domain[0] && "before:absolute before:-top-[3px] before:left-0 before:h-[7px] before:w-px before:bg-stone/60",
            lived[1] + 1 <= domain[1] && "after:absolute after:-top-[3px] after:right-0 after:h-[7px] after:w-px after:bg-stone/60"
          )}
          style={box(lived)}
        />
      )}
      {coins && (
        <span aria-hidden="true" className="absolute top-1/2 -mt-[3px] h-1.5 min-w-1.5 rounded-[3px] bg-field" style={box(coins)} />
      )}
      {office && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -mt-[3px] h-1.5 min-w-1.5 rounded-[3px] bg-ink transition-colors group-hover/track:bg-graphite"
          style={box(office)}
        />
      )}
    </span>
  )
}

/* The key above a people list: one swatch per layer (`layers`: those the list draws). */
type Layer = "lived" | "office" | "coins"
export function PersonTrackKey({
  className,
  layers = ["lived", "office", "coins"],
  coinsLabel = "Coins dated",
}: {
  className?: string
  layers?: Layer[]
  coinsLabel?: string
}) {
  return (
    <span className={cn("flex flex-wrap items-center gap-x-5 gap-y-1 text-label text-stone", className)}>
      {layers.includes("lived") && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="relative h-[7px] w-5 border-x border-stone/60 before:absolute before:inset-x-0 before:top-[3px] before:h-px before:bg-stone/60" />
          Lived
        </span>
      )}
      {layers.includes("office") && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-1.5 w-5 rounded-[3px] bg-ink" />
          In office
        </span>
      )}
      {layers.includes("coins") && (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-1.5 w-5 rounded-[3px] bg-field" />
          {coinsLabel}
        </span>
      )}
    </span>
  )
}
