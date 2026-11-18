import * as React from "react"
import { cn } from "@/lib/utils"

/*
 * A coin photo on the plinth. The image multiplies into the ground so white studio
 * backgrounds disappear. Without a photo, the plinth says so in words.
 */
export function Plinth({ src, alt = "", className }: { src?: string | null; alt?: string; className?: string }) {
  return (
    <span className={cn("flex aspect-square items-center justify-center bg-plinth p-5", className)}>
      {src ? (
        <img src={src} alt={alt} loading="lazy" className="size-full object-contain mix-blend-multiply" />
      ) : (
        <span className="text-label text-stone">No photograph yet</span>
      )}
    </span>
  )
}

/*
 * Obverse and reverse side by side on one plinth (or a single combined photo).
 * `size="hero"` is the large figure at the top of a type page.
 */
export function CoinPair({
  photos,
  size = "card",
  className,
  children,
}: {
  photos: { src: string; side: string }[]
  size?: "card" | "hero"
  className?: string
  children?: React.ReactNode
}) {
  const hero = size === "hero"
  return (
    <figure className={cn("m-0 flex flex-col bg-plinth", hero ? "gap-12 p-5" : "p-4", className)}>
      {photos.length ? (
        <div
          className={cn(
            "grid items-center",
            photos.length === 2 ? "grid-cols-2" : "grid-cols-1",
            // In the hero the coins sit further in than the caption, which keeps an even 20px edge.
            hero ? "gap-[clamp(16px,3vw,40px)] px-[clamp(0px,2vw,28px)] pt-[clamp(12px,3.5vw,52px)]" : "gap-2"
          )}
        >
          {photos.map((p) => (
            <img
              key={p.src}
              src={p.src}
              alt={p.side === "combined" ? "Obverse and reverse" : p.side === "obverse" ? "Obverse" : "Reverse"}
              loading={hero ? "eager" : "lazy"}
              className="aspect-square w-full object-contain mix-blend-multiply"
            />
          ))}
        </div>
      ) : (
        <div className="flex aspect-[2/1] items-center justify-center text-label text-stone">No photograph yet</div>
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
  title,
  reference,
  meta,
  legend,
}: {
  href: string
  image?: string | null
  title: React.ReactNode
  reference: React.ReactNode
  meta?: React.ReactNode
  legend?: React.ReactNode
}) {
  return (
    <a href={href} className="group flex flex-col gap-1">
      <Plinth src={image} className="mb-2" />
      <span className="line-clamp-2 font-serif text-reading leading-snug underline-offset-4 group-hover:underline">{title}</span>
      <span className="num text-label text-stone">
        {reference}
        {meta && <> · {meta}</>}
      </span>
      {legend}
    </a>
  )
}
