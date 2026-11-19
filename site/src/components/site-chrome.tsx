import * as React from "react"
import { cn } from "@/lib/utils"

/* Wordmark: the one place besides Latin legends where capitals are used. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <a
      href="/"
      aria-label="Solidi, home"
      className={cn("font-serif text-2xl leading-none tracking-[0.28em] text-ink", className)}
    >
      SOLIDI
    </a>
  )
}

/* Header nav link: stone, ink on hover and when current. */
export function NavLink({
  current = false,
  className,
  ...props
}: React.ComponentProps<"a"> & { current?: boolean }) {
  return (
    <a
      aria-current={current ? "page" : undefined}
      className={cn("text-ui text-stone transition-colors hover:text-ink aria-[current=page]:text-ink", className)}
      {...props}
    />
  )
}

/* Page title block: display serif at 0.95 line height, optional subtitle on the same baseline. */
export function PageTitle({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-7 gap-y-2">
      <h1 className="m-0 font-serif text-display font-normal">{title}</h1>
      {subtitle && <span className="text-subtitle text-graphite">{subtitle}</span>}
    </div>
  )
}

/* Section heading row: serif h2 on the left, a stone label (count, note) on the right. */
export function SectionHeading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 className="m-0 font-serif text-heading font-normal">{children}</h2>
      {aside && <span className="text-label text-stone">{aside}</span>}
    </div>
  )
}
