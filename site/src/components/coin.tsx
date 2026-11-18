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
