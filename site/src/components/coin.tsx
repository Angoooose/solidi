import * as React from "react"
import { cn } from "@/lib/utils"

/*
 * Photo states. Each photo carries `data-coin-photo`, the box around it `data-plinth`. Base.astro's
 * inline script marks them loaded or failed, so the states need no hydration (global.css):
 * - data-plinth="": a large plinth. A slow band of light crosses it while loading; a failed photo
 *   leaves it empty and shows its .plinth-failed note.
 * - data-plinth="small": a thumbnail. Still while loading; a failed photo leaves it empty, or
 *   shows its .plinth-fallback (a dashed outline, a line of text) once every photo has failed.
 * - data-plinth="hide": the box disappears when its photo fails.
 * A loaded photo fades in; a failed one never shows the browser's broken-image icon.
 */

/* The corner note on an empty plinth. Retry only where the plinth isn't inside a link. */
export function PlinthNote({ failed = false, retry = false, className }: { failed?: boolean; retry?: boolean; className?: string }) {
  return (
    <span className={cn("text-credit text-stone", failed && "plinth-failed", className)}>
      {failed ? "Photograph didn’t load" : "No photograph yet"}
      {failed && retry && (
        <>
          {" · "}
          <button type="button" data-coin-retry className="text-ink underline-offset-4 hover:underline">
            Retry
          </button>
        </>
      )}
    </span>
  )
}

/*
 * Without a photo, a legend pressed into the plinth, tone on tone (lib/format.ts plinthLegend
 * picks and cleans it). Its parent sets `@container` so the letters scale with the plinth.
 */
function StruckLegend({ lines }: { lines: string[] }) {
  return (
    <span aria-hidden className="plinth-legend">
      {lines.map((l, i) => (
        <span key={i} className="block">
          {l}
        </span>
      ))}
    </span>
  )
}

/*
 * A coin photo on the plinth. The image multiplies into the ground so white studio
 * backgrounds disappear. Without a photo, the plinth shows the coin's legend and says so in words.
 */
export function Plinth({
  src,
  alt = "",
  legend,
  className,
}: {
  src?: string | null
  alt?: string
  legend?: string[] | null
  className?: string
}) {
  // The image is positioned inside a square box, so a tall or wide photo can never resize the card.
  return (
    <span
      data-plinth={src ? "" : undefined}
      className={cn("@container relative flex aspect-square items-center justify-center bg-plinth", className)}
    >
      {src ? (
        <>
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            data-coin-photo
            className="absolute inset-0 size-full object-contain p-5 mix-blend-multiply"
          />
          <PlinthNote failed className="absolute bottom-3 left-3.5" />
        </>
      ) : (
        <>
          {legend && <StruckLegend lines={legend} />}
          <PlinthNote className="absolute bottom-3 left-3.5" />
        </>
      )}
    </span>
  )
}

/*
 * Obverse and reverse side by side on one plinth (or a single combined photo).
 * `size="hero"` is the large figure at the top of a type page. Its height comes from its width
 * (square coins plus a caption row), never from the facts beside it, so the coins sit at the
 * same point on every type page. The caller's caption (children)
 * holds the failure note: give it a <PlinthNote failed retry /> and mark what it replaces
 * with .plinth-caption.
 */
/* In the hero the coins sit further in than the caption, which keeps an even 20px edge. */
const HERO_ROW = "gap-[clamp(16px,3vw,40px)] px-[clamp(0px,2vw,28px)] pt-[clamp(12px,3.5vw,52px)]"

export function CoinPair({
  photos,
  legends,
  size = "card",
  className,
  children,
}: {
  photos: { src: string; side: string }[]
  /** Without photos, each side's legend pressed into the plinth (lib/format.ts plinthLegend). */
  legends?: { obverse: string[] | null; reverse: string[] | null }
  size?: "card" | "hero"
  className?: string
  children?: React.ReactNode
}) {
  const hero = size === "hero"
  return (
    // The light band crosses the whole figure while photos load, so `data-plinth` sits here.
    <figure
      data-plinth={photos.length ? "" : undefined}
      className={cn("relative m-0 flex flex-col bg-plinth", hero ? "gap-12 p-5" : "p-4", className)}
    >
      {photos.length ? (
        <div className={cn("relative grid items-center", photos.length === 2 ? "grid-cols-2" : "grid-cols-1", hero ? HERO_ROW : "gap-2")}>
          {photos.map((p) => (
            <img
              key={p.src}
              src={p.src}
              alt={p.side === "combined" ? "Obverse and reverse" : p.side === "obverse" ? "Obverse" : "Reverse"}
              loading={hero ? "eager" : "lazy"}
              data-coin-photo
              className="aspect-square w-full object-contain mix-blend-multiply"
            />
          ))}
        </div>
      ) : (
        // Laid out like a pair of photos with their caption, so the plinth keeps the same size.
        <>
          <div className={cn("grid grid-cols-2 items-center", hero ? HERO_ROW : "gap-2")}>
            {(["obverse", "reverse"] as const).map((side) => (
              <div key={side} className="@container flex aspect-square items-center justify-center">
                {legends?.[side] && <StruckLegend lines={legends[side]!} />}
              </div>
            ))}
          </div>
          <PlinthNote />
        </>
      )}
      {children}
    </figure>
  )
}

/*
 * The one coin-type card, for grids on ruler, mint, subject and search pages.
 * Title (serif) underlines on hover; reference and meta are stone data lines.
 * Search results pass the reverse description as `title` and the matched legend as `legend`.
 */
export function TypeCard({
  href,
  image,
  plinthLegend,
  title,
  reference,
  meta,
  legend,
}: {
  href: string
  image?: string | null
  /** Pressed into the plinth when there's no photo. */
  plinthLegend?: string[] | null
  title: React.ReactNode
  reference: React.ReactNode
  meta?: React.ReactNode
  legend?: React.ReactNode
}) {
  return (
    <a href={href} className="group flex flex-col gap-1">
      <Plinth src={image} legend={plinthLegend} className="mb-2" />
      <span className="line-clamp-2 font-serif text-reading leading-snug underline-offset-4 group-hover:underline">{title}</span>
      <span className="num text-ui text-stone">
        {reference}
        {meta && <> · {meta}</>}
      </span>
      {legend}
    </a>
  )
}
