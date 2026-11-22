/*
 * Building blocks of the collection pages. Server-rendered, no client state.
 */
import * as React from "react"
import { cn } from "@/lib/utils"
import { yearRange } from "@/lib/format"
import { fmt, type Facet, type MintCard, type PersonCard, type Photo } from "@/lib/categories"
import { Sparkline, YearAxis, type Bin } from "@/components/charts"
import { PlinthNote } from "@/components/coin"
import { PhotoHolder } from "@/components/credits"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@/components/ui/breadcrumb"

/* Page frame: the header's gutters, a 40px top and 112px bottom. */
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-page px-[clamp(20px,4vw,56px)] pt-10 pb-28">{children}</main>
}

/* A section below the hero: hairline above, 56px either side. */
export function Section({ className, children, ...props }: React.ComponentProps<"section">) {
  return (
    <section className={cn("mt-14 border-t border-hairline pt-14", className)} {...props}>
      {children}
    </section>
  )
}

/* Section heading (serif h2) with a link or a note on the right. */
export function SectionHead({ title, link, note }: { title: string; link?: { href: string; label: string }; note?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <h2 className="m-0 font-serif text-heading font-normal">{title}</h2>
      {link && <ActionLink href={link.href}>{link.label}</ActionLink>}
      {note && <Note>{note}</Note>}
    </div>
  )
}

/* "All 40 rulers": an action link, ink, underlined on hover. */
export function ActionLink({ className, ...props }: React.ComponentProps<"a">) {
  return <a className={cn("text-ui text-ink underline-offset-4 hover:underline", className)} {...props} />
}

export function Note({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("num text-ui text-stone", className)} {...props} />
}

/* Key numbers under a collection's title. */
export function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="m-0 flex flex-wrap gap-x-12 gap-y-4 border-t border-hairline pt-5">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-ui text-stone">{label}</dt>
          <dd className="num m-0 mt-1 text-body">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* A coin photo on the plinth, square. `size` picks the small or large source. */
export function Plinth({ photo, alt, size, className }: { photo: Photo | null; alt: string; size: "thumb" | "large"; className?: string }) {
  const src = photo?.[size]
  return (
    <span data-plinth={src ? (size === "large" ? "" : "small") : undefined} className={cn("group/plinth relative block bg-plinth", className)}>
      {src ? (
        <>
          <img src={src} alt={alt} loading="lazy" decoding="async" data-coin-photo className="block aspect-square w-full object-contain mix-blend-multiply" />
          {/* A thumbnail is too small for words: it just stays empty. */}
          {size === "large" && <PlinthNote failed className="absolute bottom-3 left-3.5" />}
          {size === "large" && <PhotoHolder holder={photo?.holder} />}
        </>
      ) : (
        <span className="block aspect-square w-full" />
      )}
    </span>
  )
}

/* A ruler or mint as a card: photo, serif name, then stone lines. */
function Card({ href, photo, name, lines, small = false }: { href: string; photo: Photo | null; name: string; lines: string[]; small?: boolean }) {
  return (
    <a href={href} className="group flex flex-col gap-0.5">
      <Plinth photo={photo} alt="" size="large" className="p-[14%]" />
      <span className={cn("mt-2.5 font-serif leading-[1.15] text-ink decoration-1 underline-offset-4 group-hover:underline", small ? "text-subtitle" : "text-reading")}>
        {name}
      </span>
      {lines.map((l) => (
        <span key={l} className="num text-ui text-stone">
          {l}
        </span>
      ))}
    </a>
  )
}

const countLine = (start: number | null, end: number | null, n: number) =>
  [yearRange(start, end), `${fmt(n)} ${n === 1 ? "type" : "types"}`].filter(Boolean).join(" · ")

export function PersonCardView({ person, small }: { person: PersonCard; small?: boolean }) {
  return <Card href={`/person/${person.id}`} photo={person.photo} name={person.name} lines={[countLine(person.start, person.end, person.n)]} small={small} />
}

export function MintCardView({ mint, categoryId, small, showRegion = true }: { mint: MintCard; categoryId: string; small?: boolean; showRegion?: boolean }) {
  return (
    <Card
      href={mintHref(mint.id, categoryId)}
      photo={mint.photo}
      name={mint.name}
      lines={[...(showRegion && mint.region ? [mint.region] : []), countLine(mint.start, mint.end, mint.n)]}
      small={small}
    />
  )
}

export const mintHref = (id: string, categoryId: string) => `/mint/${id}?collection=${categoryId}`

/* The square "373 All moneyers →" tile that ends a row of cards. */
export function MoreTile({ href, count, label }: { href: string; count: number; label: string }) {
  return (
    <a href={href} className="relative flex aspect-square flex-col justify-end border border-hairline p-[18px] text-ui text-ink transition-colors hover:bg-wash">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="absolute top-[18px] right-[18px]">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
      <span className="num font-serif text-[2.5rem] leading-none">{fmt(count)}</span>
      <span className="mt-1.5">{label}</span>
    </a>
  )
}

/*
 * One collection (or mint) as a row with its histogram: photo, name, dates (and description),
 * sparkline, count. Rows on the same page share the sparkline's axis.
 *
 * Without a photo it is the mints list's denser row: name and a stone line under it, an `aside`
 * column (the collections it struck for, or its dates), a shorter sparkline that scales to the
 * row's own peak, and no sparkline on phones. A dense row can also lead with a small picture
 * (`lead`: a coin at relative size) and add a column after the sparkline (`extra`: a weight).
 */
const ROW_COLS = {
  photo: "grid-cols-[48px_minmax(0,1fr)_auto] md:grid-cols-[64px_minmax(0,380px)_minmax(0,1fr)_72px]",
  dense: "grid-cols-(--cols) md:grid-cols-(--cols-md)",
}
/** The dense row's columns, as CSS variables for ROW_COLS.dense. */
export function denseCols({ lead = false, extra = false }: { lead?: boolean; extra?: boolean } = {}): React.CSSProperties {
  return {
    "--cols": `${lead ? "44px " : ""}minmax(0,1fr) auto`,
    "--cols-md": `${lead ? "64px " : ""}minmax(0,280px) minmax(0,var(--aside,240px)) minmax(0,1fr) ${extra ? "110px " : ""}72px`,
  } as React.CSSProperties
}

export function CollectionRow({
  href,
  photo,
  name,
  dates,
  description,
  aside,
  lead,
  extra,
  bins,
  binWidth,
  domain,
  yMax,
  ticks,
  count,
  series,
}: {
  href: string
  /** Leave out for the dense row (no photo column). */
  photo?: Photo | null
  name: string
  /** The stone line under the name: dates, or (mints) the region. */
  dates: React.ReactNode
  description?: string | null
  /** Dense row only: the second column. */
  aside?: React.ReactNode
  /** Dense row only: a small picture before the name. */
  lead?: React.ReactNode
  /** Dense row only: a column after the sparkline (wide screens). */
  extra?: React.ReactNode
  bins: Bin[]
  binWidth: number
  domain: [number, number]
  /** Dense rows default to their own peak. */
  yMax?: number
  ticks: number[]
  count: number
  /** A stacked histogram's two series, named in its tooltips. */
  series?: [string, string]
}) {
  const dense = photo === undefined
  return (
    <a
      href={href}
      className={cn(
        "group grid items-center gap-x-4 border-b border-hairline transition-[background-color,box-shadow] hover:bg-wash hover:shadow-[-12px_0_0_var(--color-wash),12px_0_0_var(--color-wash)] md:gap-x-6",
        dense ? cn(ROW_COLS.dense, "gap-y-0.5 py-2.5") : cn(ROW_COLS.photo, "gap-y-3 py-3")
      )}
      style={dense ? denseCols({ lead: lead !== undefined, extra: extra !== undefined }) : undefined}
    >
      {!dense && <Plinth photo={photo} alt="" size="thumb" className="p-1.5" />}
      {dense && lead !== undefined && <span className="row-span-2 flex items-center justify-center md:row-span-1">{lead}</span>}
      <span className={cn("flex min-w-0 flex-col", dense ? "gap-px" : "gap-[3px]")}>
        <span className={cn("font-serif leading-[1.15] text-ink decoration-1 underline-offset-4 group-hover:underline", dense ? "text-subtitle" : "text-reading")}>{name}</span>
        {dates && <span className="num text-ui text-stone">{dates}</span>}
        {description && <span className="line-clamp-2 text-ui leading-[1.45] text-graphite">{description}</span>}
      </span>
      {dense && <span className="hidden min-w-0 md:block">{aside}</span>}
      <Sparkline
        bins={bins}
        binWidth={binWidth}
        domain={domain}
        yMax={yMax ?? Math.max(1, ...bins.map((b) => b.n + (b.m ?? 0)))}
        ticks={ticks}
        height={dense ? 28 : undefined}
        series={series}
        label={`${name}: types by date${typeof dates === "string" ? `, ${dates}` : ""}`}
        className={dense ? "hidden md:block" : "col-span-3 row-start-2 md:col-span-1 md:row-start-auto"}
      />
      {dense && extra !== undefined && <span className="hidden text-right md:block">{extra}</span>}
      <span className={cn("num text-right", dense ? "[grid-column:-2/-1] row-start-1 self-start text-ui md:[grid-column:auto] md:row-start-auto md:self-center" : "col-start-3 row-start-1 text-body md:col-start-auto md:row-start-auto")}>
        {fmt(count)}
      </span>
    </a>
  )
}

/* The column header over collection rows: "Collection", the year axis, "Types". `aside` heads the dense rows' second column; `lead` and `extra` match the dense rows'. */
export function RowsHead({
  first,
  aside,
  lead = false,
  extra,
  domain,
  ticks,
  className,
}: {
  first: string
  aside?: string
  lead?: boolean
  extra?: string
  domain: [number, number]
  ticks: number[]
  className?: string
}) {
  const dense = aside !== undefined
  return (
    <div
      className={cn("grid items-end gap-6", dense ? ROW_COLS.dense : "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[64px_minmax(0,380px)_minmax(0,1fr)_72px]", className)}
      style={dense ? denseCols({ lead, extra: extra !== undefined }) : undefined}
    >
      {(!dense || lead) && <span className={dense ? undefined : "hidden md:block"} />}
      <span className="text-ui text-stone">{first}</span>
      {dense && <span className="hidden text-ui text-stone md:block">{aside}</span>}
      <YearAxis domain={domain} ticks={ticks} className="hidden md:block" />
      {extra !== undefined && <span className="hidden text-right text-ui text-stone md:block">{extra}</span>}
      <span className="text-right text-ui text-stone">Types</span>
    </div>
  )
}

/* A short ranked list: "Denominations / Tetradrachm 943 / … / All 31 denominations". */
export function FacetColumn({
  title,
  items,
  href,
  all,
}: {
  title: string
  items: Facet[]
  href: (id: string) => string
  all?: { label: string; href: string }
}) {
  if (!items.length) return null
  return (
    <div>
      <h3 className="m-0 mb-3 font-serif text-title leading-[1.15] font-normal">{title}</h3>
      {items.map((f) => (
        <a key={f.id} href={href(f.id)} className="group flex justify-between gap-3 py-1 text-ui text-ink">
          <span className="underline-offset-4 group-hover:underline">{f.name}</span>
          <span className="num text-stone">{fmt(f.n)}</span>
        </a>
      ))}
      {all && (
        <a href={all.href} className="mt-1.5 flex py-1 text-ui text-ink underline-offset-4 hover:underline">
          {all.label}
        </a>
      )}
    </div>
  )
}

/* "Collections / Greek / Hellenistic": the way up, not including the page itself. */
export function Crumbs({ items }: { items: { href: string; label: string }[] }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {items.map((c, i) => (
          <React.Fragment key={c.href}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              <BreadcrumbLink href={c.href}>{c.label}</BreadcrumbLink>
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
