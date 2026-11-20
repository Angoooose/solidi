"use client"

/*
 * The ⌘K search palette and the header button that opens it (it looks like a search field).
 *
 * People, mints and collections are matched here in the browser, from an index fetched once when
 * the browser is idle (lib/search.ts getSearchIndex), so they appear as you type. Coin types are
 * matched by catalogue number on the server (/api/search.json) when the query ends in a number:
 * "RIC II 22", "trajan 2", "rrc 494/23".
 */
import * as React from "react"
import { navigate } from "astro:transitions/client"
import { defaultFilter } from "cmdk"
import { SearchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import type { SearchIndex, SearchItem, TypeHit } from "@/lib/search"
import { asksForNumber, nameScore, nameWords } from "@/lib/searchQuery"
import basemaps from "@/lib/basemaps.generated.json"

const PAGES: SearchItem[] = [
  { name: "Collections", href: "/collections" },
  { name: "People", href: "/people" },
  { name: "Mints", href: "/mints" },
  { name: "Home", href: "/" },
].map((p) => ({ ...p, meta: "", n: 0, thumb: null }))

const LIMITS = { types: 8, people: 5, mints: 4, collections: 3, pages: 4 }
const DEBOUNCE_MS = 150

/* ---- data ---- */

let indexRequest: Promise<SearchIndex> | null = null
function loadIndex(): Promise<SearchIndex> {
  indexRequest ??= fetch("/api/search-index.json")
    .then((r) => {
      if (!r.ok) throw new Error(`Search index: ${r.status}`)
      return r.json() as Promise<SearchIndex>
    })
    .catch((err) => {
      indexRequest = null
      throw err
    })
  return indexRequest
}

function useSearchIndex(open: boolean): SearchIndex | null {
  const [index, setIndex] = React.useState<SearchIndex | null>(null)
  const load = React.useCallback(() => {
    loadIndex().then(setIndex, () => {})
  }, [])
  React.useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(load, { timeout: 4000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(load, 500)
    return () => clearTimeout(id)
  }, [load])
  React.useEffect(() => {
    if (open) load()
  }, [open, load])
  return index
}

const typeCache = new Map<string, TypeHit[]>()

/** Types for a query ending in a number, fetched after a pause in typing; `loading` until then. */
function useTypes(q: string): { types: TypeHit[]; loading: boolean } {
  const key = q.trim().toLowerCase()
  const wanted = asksForNumber(key)
  const [, rerender] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (!wanted || typeCache.has(key)) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search.json?q=${encodeURIComponent(key)}`, { signal: controller.signal })
        .then((r): Promise<{ types: TypeHit[] }> => (r.ok ? r.json() : Promise.resolve({ types: [] })))
        .then((data) => {
          typeCache.set(key, data.types)
          rerender()
        })
        .catch(() => {})
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, wanted])
  if (!wanted) return { types: [], loading: false }
  const types = typeCache.get(key)
  return { types: types ?? [], loading: !types }
}

/* ---- matching ---- */

type Group = { key: keyof typeof LIMITS; heading: string; items: SearchItem[]; best: number }

/* Names matching the query's words, best match first, then the most types. */
function match(items: SearchItem[], words: string[], limit: number): { items: SearchItem[]; best: number } {
  const scored = items.map((item) => ({ item, s: nameScore(item.name, words) })).filter((x) => x.s > 0)
  scored.sort((a, b) => b.s - a.s || b.item.n - a.item.n)
  return { items: scored.slice(0, limit).map((x) => x.item), best: scored[0]?.s ?? 0 }
}

/* A misspelling ("trajn"): letters in order, scored by cmdk's own matcher. Used only when nothing matched. */
function fuzzy(items: SearchItem[], words: string[], limit: number): { items: SearchItem[]; best: number } {
  const q = words.join(" ")
  const scored = items.map((item) => ({ item, s: defaultFilter(item.name, q) })).filter((x) => x.s > 0.1)
  scored.sort((a, b) => b.s - a.s || b.item.n - a.item.n)
  return { items: scored.slice(0, limit).map((x) => x.item), best: scored.length ? 0.5 : 0 }
}

function groupsFor(q: string, index: SearchIndex | null): Group[] {
  const words = nameWords(q)
  const sources = [
    { key: "people", heading: "People", items: index?.people ?? [] },
    { key: "mints", heading: "Mints", items: index?.mints ?? [] },
    { key: "collections", heading: "Collections", items: index?.collections ?? [] },
    { key: "pages", heading: "Go to", items: PAGES },
  ] as const
  let groups: Group[] = sources.map((s) => ({ ...s, ...match(s.items as SearchItem[], words, LIMITS[s.key]) }))
  if (words.length && !asksForNumber(q) && groups.every((g) => !g.items.length)) {
    groups = sources.map((s) => ({ ...s, ...fuzzy(s.items as SearchItem[], words, LIMITS[s.key]) }))
  }
  // The group with the best match leads ("rome": Mints); ties keep the order above.
  return groups.filter((g) => g.items.length).sort((a, b) => b.best - a.best)
}

/* ---- rows ---- */

function Thumb({ src }: { src: string | null }) {
  return (
    <span className="relative size-10 shrink-0 bg-plinth">
      {src && <img src={src} alt="" loading="lazy" className="absolute inset-0 size-full object-contain p-1 mix-blend-multiply" />}
    </span>
  )
}

/* A collection: four of its coins in a 2×2 grid, so a set reads differently from a single person or type. */
function CoinGrid({ srcs }: { srcs?: string[] }) {
  if (!srcs?.length) return <Thumb src={null} />
  return (
    <span className="grid size-10 shrink-0 grid-cols-2 grid-rows-2 gap-0.5 bg-plinth p-1">
      {srcs.slice(0, 4).map((src) => (
        <img key={src} src={src} alt="" loading="lazy" className="size-full object-contain mix-blend-multiply" />
      ))}
    </span>
  )
}

/*
 * A mint's place: the all-mints basemap (white land on a plinth sea) seen through a small window
 * centred on the mint. At 40px white land barely shows, so a filter turns it grey and leaves the
 * sea as it is: each channel is mapped linearly, sea (#F1F1EE) to itself and white to #D3D3D3.
 */
const MAP = basemaps.all
const MAP_SPAN = 120 // basemap pixels across the thumbnail: enough coast to recognise
const LAND_FILTER = "search-mint-land"

function LandFilter() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <filter id={LAND_FILTER} colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR type="linear" slope={-2.09} intercept={2.92} />
          <feFuncG type="linear" slope={-2.09} intercept={2.92} />
          <feFuncB type="linear" slope={-1.54} intercept={2.37} />
        </feComponentTransfer>
      </filter>
    </svg>
  )
}

function MintMap({ at }: { at?: [number, number] }) {
  if (!at) return <Thumb src={null} />
  const [x, y] = at
  const k = MAP_SPAN / 40 // basemap pixels per screen pixel
  return (
    <span className="size-10 shrink-0 bg-plinth">
      <svg viewBox={`${x - MAP_SPAN / 2} ${y - MAP_SPAN / 2} ${MAP_SPAN} ${MAP_SPAN}`} className="block size-full" aria-hidden="true">
        <image href="/maps/all.svg" width={MAP.width} height={MAP.height} filter={`url(#${LAND_FILTER})`} />
        <circle cx={x} cy={y} r={3 * k} strokeWidth={1.2 * k} className="fill-ink stroke-white" />
      </svg>
    </span>
  )
}

function Lines({ name, meta, serif }: { name: string; meta: string; serif?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("truncate", serif ? "font-serif text-reading leading-[1.15]" : "num text-ui")}>{name}</span>
      {meta && <span className="num truncate text-label text-stone">{meta}</span>}
    </span>
  )
}

const ROW = "h-[60px] gap-3.5 py-0"

function Skeleton() {
  return (
    <div className={cn("flex items-center px-3", ROW)} aria-hidden="true">
      <span className="size-10 shrink-0 bg-plinth" />
      <span className="flex flex-1 flex-col gap-2">
        <span className="h-3 w-40 bg-plinth" />
        <span className="h-3 w-72 max-w-full bg-plinth" />
      </span>
    </div>
  )
}

/* ---- the palette ---- */

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

export function SearchCommand({ className }: { className?: string }) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [shortcut, setShortcut] = React.useState("⌘K")
  const index = useSearchIndex(open)
  const { types, loading } = useTypes(q)

  React.useEffect(() => {
    if (!isMac()) setShortcut("Ctrl K")
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null
        if (el?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    setQ("")
    navigate(href)
  }

  const query = q.trim()
  const groups = query ? groupsFor(query, index) : []
  const numberFirst = asksForNumber(query)
  const nothing = query && !groups.length && !types.length && !loading && (index || numberFirst)

  const typeGroup = (types.length > 0 || loading) && (
    <CommandGroup heading="Types">
      {types.map((t) => (
        <CommandItem key={t.href} value={t.href} onSelect={() => go(t.href)} className={ROW}>
          <Thumb src={t.thumb} />
          <Lines name={t.reference} meta={t.meta} />
        </CommandItem>
      ))}
      {loading && !types.length && [0, 1, 2].map((i) => <Skeleton key={i} />)}
    </CommandGroup>
  )

  return (
    <>
      {/* Below lg an icon; from lg it looks like a search field. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label="Search"
        onClick={() => setOpen(true)}
        className={cn(
          "-mr-2.5 flex size-10 min-w-0 shrink-0 items-center justify-center text-left text-ui text-stone transition-colors hover:text-ink",
          "lg:mr-0 lg:h-9 lg:w-auto lg:shrink lg:justify-start lg:gap-2.5 lg:border lg:border-input lg:bg-white lg:pr-2 lg:pl-3 lg:hover:border-ink",
          className
        )}
      >
        <SearchIcon className="size-[18px] shrink-0 text-ink lg:size-4" strokeWidth={1.6} />
        <span className="hidden min-w-0 flex-1 truncate lg:block">Search</span>
        <Kbd className="hidden lg:inline-flex">{shortcut}</Kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setQ("")
        }}
        title="Search"
        description="Search people, mints, collections and catalogue numbers"
        className="top-[12vh] sm:max-w-[640px]"
        commandProps={{ shouldFilter: false, loop: true }}
      >
        <LandFilter />
        <CommandInput value={q} onValueChange={setQ} placeholder="Search…" />
        <CommandList className="max-h-[min(560px,70vh)] p-2">
          {!query && (
            <>
              <CommandGroup heading="Go to">
                {PAGES.slice(0, 3).map((p) => (
                  <CommandItem key={p.href} value={p.href} onSelect={() => go(p.href)} className="h-10 py-0">
                    {p.name}
                  </CommandItem>
                ))}
              </CommandGroup>
              {index && (
                <CommandGroup heading="Collections">
                  {index.collections.map((c) => (
                    <CommandItem key={c.href} value={c.href} onSelect={() => go(c.href)} className={ROW}>
                      <CoinGrid srcs={c.thumbs} />
                      <Lines name={c.name} meta={c.meta} serif />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </>
          )}

          {numberFirst && typeGroup}
          {groups.map((g) => (
            <CommandGroup key={g.key} heading={g.heading}>
              {g.items.map((item) => (
                <CommandItem key={item.href} value={item.href} onSelect={() => go(item.href)} className={g.key === "pages" ? "h-10 py-0" : ROW}>
                  {g.key === "pages" ? (
                    item.name
                  ) : (
                    <>
                      {g.key === "mints" ? (
                        <MintMap at={item.at} />
                      ) : g.key === "collections" ? (
                        <CoinGrid srcs={item.thumbs} />
                      ) : (
                        <Thumb src={item.thumb} />
                      )}
                      <Lines name={item.name} meta={item.meta} serif />
                    </>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {!numberFirst && typeGroup}

          {nothing && (
            <p className="m-0 px-3 py-8 text-center text-ui text-stone">
              No people, mints or catalogue numbers match “{query}”.
            </p>
          )}
        </CommandList>
      </CommandDialog>
    </>
  )
}
