/*
 * Tooltips for chart marks and map mints: any element with `data-tip="…"` shows its text in a
 * small ink label beside the pointer. Works for mouse (hover), keyboard (focus) and touch (tap
 * shows it, a tap elsewhere hides it). One listener on the document, so marks rendered by the
 * server need no JavaScript of their own. The label is never needed to read the page: every
 * chart also states its numbers in text or an aria-label.
 *
 * An element can also carry `data-tip-rich` (JSON: see RichTip) for a light card with a title,
 * rows keyed by a swatch that matches the mark they describe, and a footer. `data-tip` stays as
 * its plain-text form (and is what marks the element as having a tip).
 */
type Swatch = "lived" | "office" | "coins" | "series" | "series-alt"
type RichTip = {
  title: string
  subtitle?: string
  /** Label and value, keyed by a swatch where the card describes several kinds of mark. */
  rows: [Swatch | null, string, string][]
  foot?: string
}

const DARK = "max-w-xs whitespace-pre-line bg-ink px-2 py-1 text-credit text-white"
const LIGHT = "min-w-[240px] max-w-sm rounded-md border border-hairline bg-white px-3.5 pt-3 pb-2.5 text-ink shadow-[0_12px_32px_-12px_rgb(20_20_20/0.25),0_2px_6px_rgb(20_20_20/0.06)]"
/* Each swatch drawn as its mark is in the chart (see PersonTrack). */
const SWATCH: Record<Swatch, string> = {
  lived: "relative h-[7px] w-5 border-x border-stone/60 before:absolute before:inset-x-0 before:top-[3px] before:h-px before:bg-stone/60",
  office: "h-1.5 w-5 rounded-[3px] bg-ink",
  coins: "h-1.5 w-5 rounded-[3px] bg-field",
  /* A stacked histogram's two series (Sparkline, .bar and .bar-alt). */
  series: "size-2.5 rounded-[2px] bg-ink",
  "series-alt": "size-2.5 rounded-[2px] bg-[color-mix(in_srgb,var(--color-stone)_45%,white)]",
}

function el(tag: string, className: string, text?: string) {
  const node = document.createElement(tag)
  node.className = className
  if (text != null) node.textContent = text
  return node
}

function rich(data: RichTip): HTMLElement {
  const box = el("div", "")
  box.appendChild(el("div", "font-serif text-[1.1875rem] leading-[1.2]", data.title))
  if (data.subtitle) box.appendChild(el("div", "mt-0.5 text-label text-stone", data.subtitle))
  const keyed = data.rows.some(([kind]) => kind)
  const grid = el("div", `mt-2.5 grid items-center gap-x-3 gap-y-1.5 ${keyed ? "grid-cols-[20px_auto_1fr]" : "grid-cols-[auto_1fr]"}`)
  for (const [kind, label, value] of data.rows) {
    if (keyed) grid.appendChild(el("span", kind ? SWATCH[kind] : ""))
    grid.appendChild(el("span", "text-label text-stone", label))
    grid.appendChild(el("span", "num text-right text-ui text-ink", value))
  }
  box.appendChild(grid)
  if (data.foot) box.appendChild(el("div", "num mt-2.5 border-t border-hairline pt-2 text-label text-graphite", data.foot))
  return box
}

let tip: HTMLDivElement | null = null
let current: Element | null = null

function label(): HTMLDivElement {
  if (tip?.isConnected) return tip
  tip = document.createElement("div")
  tip.setAttribute("role", "tooltip")
  tip.style.opacity = "0"
  document.body.appendChild(tip)
  return tip
}

function place(x: number, y: number) {
  const node = label()
  const { width, height } = node.getBoundingClientRect()
  const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8)
  const top = y - height - 12 < 8 ? y + 18 : y - height - 12
  node.style.left = `${left}px`
  node.style.top = `${top}px`
}

function show(target: Element, x?: number, y?: number) {
  const text = target.getAttribute("data-tip")
  if (!text) return
  current?.removeAttribute("data-tip-active")
  current = target
  target.setAttribute("data-tip-active", "")
  const box = label()
  const data = target.getAttribute("data-tip-rich")
  let parsed: RichTip | null = null
  try {
    parsed = data ? (JSON.parse(data) as RichTip) : null
  } catch {
    parsed = null
  }
  box.className = `pointer-events-none fixed z-50 transition-opacity duration-100 ${parsed ? LIGHT : DARK}`
  if (parsed) {
    box.textContent = ""
    box.appendChild(rich(parsed))
  }
  else box.textContent = text
  if (x == null || y == null) {
    const r = target.getBoundingClientRect()
    x = r.left + r.width / 2
    y = r.top
  }
  place(x, y)
  box.style.opacity = "1"
}

function hide() {
  current?.removeAttribute("data-tip-active")
  current = null
  if (tip) tip.style.opacity = "0"
}

const tipTarget = (e: Event) => (e.target instanceof Element ? e.target.closest("[data-tip]") : null)

document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return
  const t = tipTarget(e)
  if (t) show(t, e.clientX, e.clientY)
  else if (current) hide()
})
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return
  const t = tipTarget(e)
  if (t && t !== current) show(t)
  else hide()
})
document.addEventListener("focusin", (e) => {
  const t = tipTarget(e)
  if (t) show(t)
})
document.addEventListener("focusout", hide)
window.addEventListener("scroll", hide, { passive: true })
document.addEventListener("astro:before-swap", hide)
