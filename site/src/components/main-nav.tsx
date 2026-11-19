import * as React from "react"
import { cn } from "@/lib/utils"
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu"
import { Skeleton } from "@/components/ui/skeleton"
import type { CollectionsMenu, MenuCard, MenuLink } from "@/lib/collections"

/*
 * The header's main nav: a Collections menu, then plain links. The menu is
 * a rail of every collection with its count on the left, and on
 * the right cards for whichever collection is hovered or focused (its rulers, mints or
 * sub-collections), with links into the indexes underneath.
 *
 * The menu's data is fetched once, when the browser is idle (or on first hover), and kept for the
 * rest of the visit: it is the same on every page and would otherwise weigh down each one.
 */

const LINKS = [
  ["Mints", "/mints"],
  ["Denominations", "/denominations"],
  ["Subjects", "/subjects"],
  ["Map", "/map"],
] as const

export type MainNavCurrent = "Collections" | (typeof LINKS)[number][0]

let request: Promise<CollectionsMenu> | null = null
function loadMenu(): Promise<CollectionsMenu> {
  request ??= fetch("/api/collections.json")
    .then((r) => {
      if (!r.ok) throw new Error(`Collections menu: ${r.status}`)
      return r.json() as Promise<CollectionsMenu>
    })
    .catch((err) => {
      request = null
      throw err
    })
  return request
}

type MenuState = { data: CollectionsMenu | null; failed: boolean }

function useCollectionsMenu(): MenuState & { load: () => void } {
  const [state, setState] = React.useState<MenuState>({ data: null, failed: false })
  const load = React.useCallback(() => {
    loadMenu().then(
      (data) => setState({ data, failed: false }),
      () => setState((s) => ({ ...s, failed: true }))
    )
  }, [])
  React.useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(load, { timeout: 3000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(load, 300)
    return () => clearTimeout(id)
  }, [load])
  return { ...state, load }
}

const ALL = "all"

export function MainNav({ current }: { current?: MainNavCurrent }) {
  const menu = useCollectionsMenu()
  return (
    <NavigationMenu
      aria-label="Main"
      // Static, so the panel hangs from the header (the nearest positioned box), centred in the page.
      className="static items-stretch self-stretch"
      viewportClassName="inset-x-0 px-[clamp(20px,4vw,56px)]"
    >
      <NavigationMenuList className="h-full flex-wrap items-stretch gap-x-7">
        <NavigationMenuItem className="flex">
          <NavigationMenuTrigger
            data-active={current === "Collections" ? "" : undefined}
            onPointerEnter={menu.load}
            onFocus={menu.load}
          >
            Collections
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <CollectionsPanel {...menu} />
          </NavigationMenuContent>
        </NavigationMenuItem>
        {LINKS.map(([label, href]) => (
          <NavigationMenuItem key={href} className="flex">
            <NavigationMenuLink href={href} active={current === label} className={navigationMenuTriggerStyle()}>
              {label}
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenu>
  )
}

/* The open panel: rail on the left, the hovered collection's cards on the right (from md up). */
function CollectionsPanel({ data, failed }: MenuState) {
  const [active, setActive] = React.useState(ALL)

  return (
    <div className="grid max-h-[calc(100dvh-140px)] w-full overflow-y-auto md:w-[min(1040px,calc(100vw-2*clamp(20px,4vw,56px)))] md:grid-cols-[280px_1fr] md:overflow-visible">
      {data ? (
        <>
          <Rail data={data} active={active} onActivate={setActive} />
          <Preview data={data} active={active} />
        </>
      ) : failed ? (
        <p className="m-0 px-8 py-7 text-ui text-stone">Collections could not be loaded. Try again in a moment.</p>
      ) : (
        <RailSkeleton />
      )}
    </div>
  )
}

/*
 * Every collection, depth first. Top-level collections (Greek, Roman) are serif group headings;
 * a collection with children under one (Hellenistic) is a small label; the rest are rows with counts.
 */
function Rail({ data, active, onActivate }: { data: CollectionsMenu; active: string; onActivate: (id: string) => void }) {
  const hasChildren = new Set(data.collections.map((c) => c.parentId).filter(Boolean))
  const activate = (id: string) => ({ onPointerEnter: () => onActivate(id), onFocus: () => onActivate(id) })

  return (
    <nav aria-label="Collections" className="flex flex-col px-8 pt-7 pb-8 md:border-r md:border-hairline">
      <RailRow href="/collections" count={data.all.count} on={active === ALL} className="mb-[18px]" {...activate(ALL)}>
        All collections
      </RailRow>
      {data.collections.map((c, i) =>
        c.depth === 0 ? (
          <NavigationMenuLink
            key={c.id}
            href={`/category/${c.id}`}
            className={cn("mb-1.5 font-serif text-[1.25rem] leading-[1.15] text-ink hover:text-stone", i > 0 && "mt-5")}
            {...activate(c.id)}
          >
            {c.name}
          </NavigationMenuLink>
        ) : hasChildren.has(c.id) ? (
          <NavigationMenuLink
            key={c.id}
            href={`/category/${c.id}`}
            className={cn("mt-2.5 mb-0.5 text-label text-stone hover:text-ink", active === c.id && "text-ink")}
            {...activate(c.id)}
          >
            {c.shortName}
          </NavigationMenuLink>
        ) : (
          <RailRow key={c.id} href={`/category/${c.id}`} count={c.count} on={active === c.id} {...activate(c.id)}>
            {c.shortName}
          </RailRow>
        )
      )}
    </nav>
  )
}

function RailRow({
  count,
  on,
  className,
  children,
  ...props
}: React.ComponentProps<typeof NavigationMenuLink> & { count: number; on: boolean }) {
  return (
    <NavigationMenuLink
      data-on={on || undefined}
      className={cn(
        "-mx-3 flex items-baseline justify-between gap-3 px-3 py-[7px] text-ui text-graphite transition-colors hover:bg-wash hover:text-ink data-on:bg-plinth data-on:text-ink",
        className
      )}
      {...props}
    >
      {children}
      <span className="num text-label text-stone">{count.toLocaleString("en-GB")}</span>
    </NavigationMenuLink>
  )
}

/* The right-hand side: the active collection's name, cards and index links. Hidden on phones. */
function Preview({ data, active }: { data: CollectionsMenu; active: string }) {
  const c = active === ALL ? null : data.collections.find((x) => x.id === active)
  const view = c
    ? { title: c.name, href: `/category/${c.id}`, meta: c.meta, cards: c.cards, links: c.links }
    : { title: "All collections", href: "/collections", meta: data.all.meta, cards: data.all.cards, links: data.all.links }

  return (
    <div className="hidden flex-col gap-6 px-10 pt-8 pb-7 md:flex">
      <div className="flex items-baseline justify-between gap-6">
        <NavigationMenuLink href={view.href} className="font-serif text-[1.875rem] leading-[1.05] tracking-[-0.01em] hover:text-stone">
          {view.title}
        </NavigationMenuLink>
        <span className="num shrink-0 text-label text-stone">{view.meta}</span>
      </div>
      {view.cards.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-2 gap-x-10 gap-y-4 p-0">
          {view.cards.map((card) => (
            <li key={card.href}>
              <Card card={card} />
            </li>
          ))}
        </ul>
      )}
      {view.links.length > 0 && <IndexLinks links={view.links} />}
    </div>
  )
}

function Card({ card }: { card: MenuCard }) {
  return (
    <NavigationMenuLink
      href={card.href}
      className="-m-2 grid grid-cols-[56px_1fr] items-center gap-3.5 p-2 transition-colors hover:bg-wash"
    >
      <span className="block bg-plinth p-1.5">
        {card.image ? (
          <img src={card.image} alt="" loading="lazy" className="block aspect-square w-full object-contain mix-blend-multiply" />
        ) : (
          <span className="block aspect-square w-full" />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-serif text-[1.1875rem] leading-[1.15] text-ink">{card.name}</span>
        <span className="num text-label text-stone">{card.meta}</span>
      </span>
    </NavigationMenuLink>
  )
}

function IndexLinks({ links }: { links: MenuLink[] }) {
  return (
    <div className="mt-auto flex flex-wrap items-baseline gap-x-7 gap-y-2 border-t border-hairline pt-5">
      {links.map((l) => (
        <NavigationMenuLink key={l.label} href={l.href} className="text-ui text-ink underline-offset-4 hover:underline">
          {l.label}
          <span className="num ml-1.5 text-stone">{l.count.toLocaleString("en-GB")}</span>
        </NavigationMenuLink>
      ))}
    </div>
  )
}

function RailSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-8 pt-7 pb-8 md:col-span-2" aria-busy="true" aria-label="Loading collections">
      {Array.from({ length: 9 }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 4 === 0 ? "w-28" : "w-52")} />
      ))}
    </div>
  )
}
