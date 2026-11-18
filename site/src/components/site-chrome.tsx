import * as React from "react"
import { cn } from "@/lib/utils"
import { SearchField } from "./search"
import { IMAGE_CREDITS_URL } from "@/lib/credits"

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

const MAIN_NAV = [
  ["Rulers", "/rulers"],
  ["Mints", "/mints"],
  ["Denominations", "/denominations"],
  ["Subjects", "/subjects"],
  ["Map", "/map"],
] as const

export function SiteHeader({ current }: { current?: string }) {
  return (
    <header className="border-b border-hairline">
      <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-11 gap-y-4 px-[clamp(20px,4vw,56px)] py-4">
        <Wordmark />
        <nav aria-label="Main" className="flex flex-wrap gap-x-7">
          {MAIN_NAV.map(([label, href]) => (
            <NavLink key={href} href={href} current={current === label}>
              {label}
            </NavLink>
          ))}
        </nav>
        <SearchField className="w-full sm:ml-auto sm:w-auto sm:min-w-[220px] sm:flex-[0_1_320px]" placeholder="Reference, legend or ruler" shortcut="⌘K" />
        <nav aria-label="Site" className="flex gap-x-7">
          <NavLink href="/about">About</NavLink>
          <NavLink href="/sources">Sources</NavLink>
        </nav>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-page flex-wrap justify-between gap-x-8 gap-y-3 px-[clamp(20px,4vw,56px)] pt-7 pb-10 text-label text-stone">
        <span>Solidi is a non-commercial encyclopedia built on OCRE, Nomisma and museum collections.</span>
        <span>
          Data ODbL ·{" "}
          <a href={IMAGE_CREDITS_URL} className="underline-offset-4 hover:text-ink hover:underline">
            Image credits
          </a>
        </span>
      </div>
    </footer>
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
