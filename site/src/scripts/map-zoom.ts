/*
 * Pan and zoom for mint maps (components/mint-map.tsx): drag to pan, scroll or pinch to zoom, and
 * +/−/reset buttons. Circles and labels keep their size on screen as the map zooms, so crowded
 * coasts (the Aegean) separate instead of growing together. Loaded only on pages with a map.
 */
import { select } from "d3-selection"
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom"

function setup(root: HTMLElement) {
  if (root.dataset.zoomReady) return
  root.dataset.zoomReady = "1"
  const svg = root.querySelector<SVGSVGElement>("svg")
  const layer = root.querySelector<SVGGElement>("[data-zoom]")
  if (!svg || !layer) return
  const [, , w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number)
  const circles = [...layer.querySelectorAll<SVGCircleElement>("circle")]
  const labels = [...layer.querySelectorAll<SVGGElement>("[data-label]")]
  const anchors = labels.map((g) => g.getAttribute("transform")!)

  const behaviour: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .scaleExtent([1, 12])
    .translateExtent([[0, 0], [w, h]])
    .extent([[0, 0], [w, h]])
    // Scroll zooms only with a modifier or on the map's own controls, so the page still scrolls.
    .filter((e: Event) => (e.type === "wheel" ? (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey : !(e as MouseEvent).button))
    .on("zoom", ({ transform }) => {
      layer.setAttribute("transform", transform.toString())
      const k = transform.k
      for (const c of circles) {
        c.setAttribute("r", String(Number(c.dataset.r) / k))
        c.setAttribute("stroke-width", String(1 / k))
      }
      labels.forEach((g, i) => g.setAttribute("transform", `${anchors[i]} scale(${1 / k})`))
    })
  const s = select(svg).call(behaviour)
  const controls = root.querySelector<HTMLElement>("[data-zoom-controls]")
  if (controls) controls.hidden = false
  root.querySelector("[data-zoom-in]")?.addEventListener("click", () => s.call(behaviour.scaleBy, 1.8))
  root.querySelector("[data-zoom-out]")?.addEventListener("click", () => s.call(behaviour.scaleBy, 1 / 1.8))
  root.querySelector("[data-zoom-reset]")?.addEventListener("click", () => s.call(behaviour.transform, zoomIdentity))
}

const init = () => document.querySelectorAll<HTMLElement>(".mint-map").forEach(setup)
init()
document.addEventListener("astro:page-load", init)
