/*
 * Tooltips for chart marks and map mints: any element with `data-tip="…"` shows its text in a
 * small ink label beside the pointer. Works for mouse (hover), keyboard (focus) and touch (tap
 * shows it, a tap elsewhere hides it). One listener on the document, so marks rendered by the
 * server need no JavaScript of their own. The label is never needed to read the page: every
 * chart also states its numbers in text or an aria-label.
 */
let tip: HTMLDivElement | null = null
let current: Element | null = null

function label(): HTMLDivElement {
  if (tip?.isConnected) return tip
  tip = document.createElement("div")
  tip.setAttribute("role", "tooltip")
  tip.className =
    "pointer-events-none fixed z-50 max-w-xs bg-ink px-2 py-1 text-credit text-white opacity-0 transition-opacity duration-100"
  document.body.appendChild(tip)
  return tip
}

function place(x: number, y: number) {
  const el = label()
  const { width, height } = el.getBoundingClientRect()
  const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8)
  const top = y - height - 12 < 8 ? y + 18 : y - height - 12
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

function show(target: Element, x?: number, y?: number) {
  const text = target.getAttribute("data-tip")
  if (!text) return
  current?.removeAttribute("data-tip-active")
  current = target
  target.setAttribute("data-tip-active", "")
  const el = label()
  el.textContent = text
  if (x == null || y == null) {
    const r = target.getBoundingClientRect()
    x = r.left + r.width / 2
    y = r.top
  }
  place(x, y)
  el.style.opacity = "1"
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
