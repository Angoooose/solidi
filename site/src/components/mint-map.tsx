/*
 * A collection's mints on its basemap, sized by number of types. Server-rendered SVG: the land is
 * a static file (public/maps/<category>.svg, from scripts/basemaps.mjs), the mints are circles
 * drawn here with the same projection, in one translucent tone so crowded coasts darken where dots
 * overlap. The biggest mints are named. Hovering a mint shows a card (data-tip-rich,
 * scripts/tooltip.ts): its region, output and dates; clicking one opens its page. Pan and zoom come from scripts/map-zoom.ts.
 *
 * With `focus`, it is a still locator map instead (the mint page): a window onto the basemap
 * centred on one mint, drawn alone, with no pan or zoom.
 */
import * as React from "react"
import { geoMercator } from "d3-geo"
import { scaleSqrt } from "d3-scale"
import { yearRange } from "@/lib/format"
import { fmt, typesLabel, type MapMint } from "@/lib/categories"
import basemaps from "@/lib/basemaps.generated.json"

type Basemap = { width: number; height: number; scale: number; translate: [number, number]; center: [number, number] }
const BASEMAPS = basemaps as unknown as Record<string, Basemap>

/** A basemap is keyed by collection id, or "all" for every mint. */
export function hasBasemap(key: string) {
  return key in BASEMAPS
}

/** Whether a point falls on a basemap (the all-mints map stops short of Bactria and India). */
export function onBasemap(key: string, lon: number, lat: number) {
  const map = BASEMAPS[key]
  if (!map) return false
  const [x, y] = geoMercator().scale(map.scale).translate(map.translate).center(map.center)([lon, lat]) ?? [NaN, NaN]
  return x >= 0 && x <= map.width && y >= 0 && y <= map.height
}

/** Short name for a label: "Abdera, Thrace" -> "Abdera". */
const short = (name: string) => name.split(",")[0].replace(/\s*\(.*\)$/, "")

const CHAR = 6.6 // average Geist 12px glyph width, for label collision checks

export function MintMap({
  basemap,
  mints,
  labelled = 12,
  label,
  focus,
}: {
  /** The collection id, or "all". */
  basemap: string
  mints: MapMint[]
  labelled?: number
  label: string
  /** A locator map: this window (in screen px, zoomed `zoom` times) centred on the one mint given. */
  focus?: { width: number; height: number; zoom: number }
}) {
  const map = BASEMAPS[basemap]
  if (!map || !mints.length) return null
  const { width: W, height: H } = map
  const project = geoMercator().scale(map.scale).translate(map.translate).center(map.center)
  if (focus) return <Locator basemap={basemap} map={map} mint={mints[0]} project={project} label={label} {...focus} />
  const max = Math.max(...mints.map((m) => m.n))
  const r = scaleSqrt().domain([0, max]).range([2.5, 17])

  const placed = mints
    .map((m, rank) => {
      const [x, y] = project([m.lon, m.lat]) ?? [NaN, NaN]
      return { ...m, x, y, r: r(m.n), rank }
    })
    .filter((m) => Number.isFinite(m.x) && m.x >= -20 && m.x <= W + 20 && m.y >= -20 && m.y <= H + 20)

  // Labels for the biggest mints: right of the circle, else left, above or below, skipping any
  // that would overlap a label or circle already placed, or run off the frame.
  type Box = { x0: number; y0: number; x1: number; y1: number }
  // Labels may cover smaller mints, never a labelled one's circle.
  const boxes: Box[] = placed.slice(0, labelled).map((m) => ({ x0: m.x - m.r, y0: m.y - m.r, x1: m.x + m.r, y1: m.y + m.r }))
  const overlaps = (b: Box) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
  const labels: { id: string; x: number; y: number; dx: number; dy: number; anchor: "start" | "end" | "middle"; text: string }[] = []
  for (const m of placed.slice(0, labelled)) {
    const text = short(m.name)
    const w = text.length * CHAR
    const options = [
      { dx: m.r + 4, dy: 4, anchor: "start" as const, box: { x0: m.x + m.r + 3, y0: m.y - 8, x1: m.x + m.r + 5 + w, y1: m.y + 6 } },
      { dx: -m.r - 4, dy: 4, anchor: "end" as const, box: { x0: m.x - m.r - 5 - w, y0: m.y - 8, x1: m.x - m.r - 3, y1: m.y + 6 } },
      { dx: 0, dy: -m.r - 6, anchor: "middle" as const, box: { x0: m.x - w / 2, y0: m.y - m.r - 18, x1: m.x + w / 2, y1: m.y - m.r - 4 } },
      { dx: 0, dy: m.r + 14, anchor: "middle" as const, box: { x0: m.x - w / 2, y0: m.y + m.r + 2, x1: m.x + w / 2, y1: m.y + m.r + 16 } },
    ]
    const fit = options.find((o) => o.box.x0 >= 4 && o.box.x1 <= W - 4 && o.box.y0 >= 4 && o.box.y1 <= H - 4 && !overlaps(o.box))
    if (!fit) continue
    boxes.push(fit.box)
    labels.push({ id: m.id, x: m.x, y: m.y, dx: fit.dx, dy: fit.dy, anchor: fit.anchor, text })
  }

  // The hover card: where it is, how much it struck and when.
  const card = (m: (typeof placed)[number]) => {
    const dates = yearRange(m.start, m.end)
    return {
      title: m.name,
      subtitle: m.region ?? undefined,
      rows: [
        [null, "Types", fmt(m.n)],
        ...(dates ? [[null, "Struck", dates]] : []),
      ],
    }
  }

  return (
    <div className="mint-map relative bg-plinth">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} className="block touch-none select-none">
        <g data-zoom>
          <image href={`/maps/${basemap}.svg`} width={W} height={H} />
          {/* Biggest first, so small mints sit on top and stay hoverable. */}
          {/* Each dot opens its mint. Out of the tab order: the page's mint list is the keyboard route. */}
          {placed.map((m) => (
            <a key={m.id} href={`/mint/${m.id}`} tabIndex={-1} className="mint-link">
              <circle
                cx={m.x}
                cy={m.y}
                r={m.r}
                data-r={m.r}
                strokeWidth={1}
                className="mint-dot"
                data-tip={[m.name, m.region, yearRange(m.start, m.end), typesLabel(m.n)].filter(Boolean).join(" · ")}
                data-tip-rich={JSON.stringify(card(m))}
              />
            </a>
          ))}
          {labels.map((l) => (
            <g key={l.id} transform={`translate(${l.x} ${l.y})`} data-label>
              <text x={l.dx} y={l.dy} textAnchor={l.anchor} className="map-label">
                {l.text}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="absolute right-3 bottom-3 flex flex-col border border-hairline bg-white" data-zoom-controls hidden>
        <button type="button" data-zoom-in aria-label="Zoom in" className="grid size-9 place-items-center text-ui text-ink hover:bg-wash">
          +
        </button>
        <button type="button" data-zoom-out aria-label="Zoom out" className="grid size-9 place-items-center border-t border-hairline text-ui text-ink hover:bg-wash">
          −
        </button>
        <button type="button" data-zoom-reset aria-label="Show the whole map" className="grid size-9 place-items-center border-t border-hairline text-ink hover:bg-wash">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/*
 * The mint page's map: the basemap seen through a window centred on the mint, the mint drawn alone
 * with its name. Sizes are divided by the zoom so the dot and label read at their usual size.
 */
function Locator({
  basemap,
  map,
  mint,
  project,
  label,
  width,
  height,
  zoom,
}: {
  basemap: string
  map: Basemap
  mint: MapMint
  project: ReturnType<typeof geoMercator>
  label: string
  width: number
  height: number
  zoom: number
}) {
  const [x, y] = project([mint.lon, mint.lat]) ?? [NaN, NaN]
  if (!Number.isFinite(x)) return null
  const w = width / zoom, h = height / zoom
  // Keep the window on the map: a coastal mint sits off-centre rather than beside blank space.
  const x0 = Math.min(Math.max(0, x - w / 2), map.width - w)
  const y0 = Math.min(Math.max(0, y - h / 2), map.height - h)
  const k = 1 / zoom
  const right = x + 90 * k < x0 + w
  return (
    <div className="mint-map relative bg-plinth">
      <svg viewBox={`${x0} ${y0} ${w} ${h}`} width="100%" role="img" aria-label={label} className="block">
        <image href={`/maps/${basemap}.svg`} width={map.width} height={map.height} />
        <circle cx={x} cy={y} r={5 * k} strokeWidth={k} className="mint-dot lead" />
        <text x={x + (right ? 10 : -10) * k} y={y + 4 * k} textAnchor={right ? "start" : "end"} className="map-label" style={{ fontSize: 13 * k, strokeWidth: 3 * k }}>
          {short(mint.name)}
        </text>
      </svg>
    </div>
  )
}

/**
 * Every mint as one small dot on the all-mints basemap, framed on the Mediterranean (the
 * home page's Mints door). A picture, not a chart: no labels or tooltips. Ink dots with a white ring,
 * like a printed atlas, over a small size range, so the big mints anchor it and packed ones stay apart. It fills its box,
 * cropping the edges.
 */
export function MintDots({ mints, className }: { mints: { id: string; lon: number; lat: number; n: number }[]; className?: string }) {
  const map = BASEMAPS.all
  if (!map) return null
  const project = geoMercator().scale(map.scale).translate(map.translate).center(map.center)
  // Spain to Mesopotamia, the Danube to Egypt.
  const [x0, y0] = project([-9, 52])!
  const [x1, y1] = project([47, 27])!
  const max = Math.max(1, ...mints.map((m) => m.n))
  const r = scaleSqrt().domain([0, max]).range([1.2, 5.5])
  // Biggest first, so the small ones sit on top; the white ring keeps packed dots apart.
  const sorted = [...mints].sort((a, b) => b.n - a.n)
  return (
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" className={className}>
      <image href="/maps/all.svg" width={map.width} height={map.height} />
      {sorted.map((m) => {
        const [x, y] = project([m.lon, m.lat]) ?? [NaN, NaN]
        return Number.isFinite(x) ? <circle key={m.id} cx={x} cy={y} r={r(m.n)} strokeWidth={0.6} className="fill-ink stroke-white" /> : null
      })}
    </svg>
  )
}
