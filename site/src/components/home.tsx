/*
 * Home page pieces: an index line with a dotted leader, a door (picture, name and
 * count, a sentence, its top four, "All …"), and a half of the collection tree.
 */
import * as React from "react"
import { cn } from "@/lib/utils"
import { fmt } from "@/lib/categories"
import type { Category } from "@/lib/categories"
import type { HomeCollection, Top } from "@/lib/home"
import { Coin } from "@/components/denomination"
import { MintDots } from "@/components/mint-map"
import type { Photo } from "@/lib/categories"

/** "Constantine I ........ 4,096" */
export function IndexLine({ href, name, n, className }: { href?: string; name: string; n: number; className?: string }) {
  const body = (
    <>
      <span className="min-w-0 truncate text-ui leading-normal decoration-1 underline-offset-4 group-hover:underline">{name}</span>
      <span aria-hidden="true" className="min-w-4 flex-1 -translate-y-1 border-b border-dotted border-field" />
      <span className="num text-label text-stone">{fmt(n)}</span>
    </>
  )
  const cls = cn("group flex items-baseline gap-2.5 py-1.5 text-ink", className)
  return href ? (
    <a href={href} className={cls}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/* "All 1,996 people →" */
export function ArrowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="group/arrow text-ui font-medium text-ink">
      {children}{" "}
      <span aria-hidden="true" className="inline-block transition-transform group-hover/arrow:translate-x-[3px] motion-reduce:transition-none">
        →
      </span>
    </a>
  )
}

/** A door's picture: one coin, coins at relative size, or every mint on a map. */
export type DoorPicture =
  | { kind: "coin"; photo: Photo | null }
  | { kind: "coins"; coins: { id: string; name: string; diameter: number; photo: Photo | null }[] }
  | { kind: "mints"; mints: { id: string; lon: number; lat: number; n: number }[] }

export function Door({
  href,
  title,
  total,
  noun,
  text,
  picture,
  top,
  itemHref,
}: {
  href: string
  title: string
  total: number
  noun: string
  text: string
  picture: DoorPicture
  top: Top[]
  itemHref: (id: string) => string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <a href={href} tabIndex={-1} aria-hidden="true" className="flex h-[240px] items-center justify-center overflow-hidden bg-plinth transition-colors hover:bg-[#ebebe7]">
        {picture.kind === "coin" ? (
          <Coin photo={picture.photo} px={176} />
        ) : picture.kind === "coins" ? (
          <DoorCoins coins={picture.coins} />
        ) : (
          <MintDots mints={picture.mints} className="block size-full" />
        )}
      </a>
      <a href={href} className="group flex items-baseline justify-between gap-3 text-ink">
        <span className="font-serif text-[1.875rem] leading-[1.1] decoration-1 underline-offset-4 group-hover:underline">{title}</span>
        <span className="num text-label text-stone">{fmt(total)}</span>
      </a>
      <p className="m-0 text-ui leading-normal text-graphite">{text}</p>
      <div className="flex flex-col border-t border-hairline pt-1.5">
        {top.map((x) => (
          <IndexLine key={x.id} href={itemHref(x.id)} name={x.name} n={x.n} />
        ))}
      </div>
      <ArrowLink href={href}>
        All {fmt(total)} {noun}
      </ArrowLink>
    </div>
  )
}

/** Coins side by side at relative size, bottom-aligned (the Denominations door). */
export function DoorCoins({ coins, max = 112 }: { coins: { id: string; name: string; diameter: number; photo: Photo | null }[]; max?: number }) {
  if (!coins.length) return null
  const scale = max / Math.max(...coins.map((c) => c.diameter))
  return (
    <span className="flex h-full items-end justify-center gap-3.5 px-4 pb-16">
      {coins.map((c) => (
        <Coin key={c.id} photo={c.photo} px={Math.round(c.diameter * scale)} alt={c.name} className="flex-none" />
      ))}
    </span>
  )
}

/* One half of the collection tree: its photo, name and totals, then its collections. */
export function CollectionHalf({ half }: { half: HomeCollection }) {
  const leaves = half.children.flatMap((c) => c.sub ?? [c])
  const line = (c: Category, indent = false) => <IndexLine key={c.id} href={`/category/${c.id}`} name={c.name} n={c.types} className={indent ? "pl-3.5" : undefined} />
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <a href={`/category/${half.category.id}`} className="group flex items-center gap-6 text-ink">
        <span className="flex size-28 flex-none items-center justify-center bg-plinth transition-colors group-hover:bg-[#ebebe7]">
          <Coin photo={half.photo} px={84} />
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-serif text-[1.875rem] leading-[1.1] decoration-1 underline-offset-4 group-hover:underline">{half.category.name}</span>
          <span className="num text-label text-stone">
            {fmt(half.category.types)} types in {leaves.length} {leaves.length === 1 ? "collection" : "collections"}
          </span>
        </span>
      </a>
      <div className="flex flex-col border-t border-hairline pt-1.5">
        {half.children.map((c) =>
          c.sub ? (
            <React.Fragment key={c.id}>
              <a href={`/category/${c.id}`} className="mt-3.5 pt-1.5 pb-0.5 text-label text-stone underline-offset-4 hover:text-ink hover:underline">
                {c.name}
              </a>
              {c.sub.map((s) => line(s, true))}
            </React.Fragment>
          ) : (
            line(c)
          )
        )}
      </div>
    </div>
  )
}
