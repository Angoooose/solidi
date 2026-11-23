"use client"

/*
 * Filters and sort for a coinage grid. Each change navigates to a new URL (swapped in place by
 * the client router), so the server renders the filtered grid and every view can be shared.
 * Which filters show depends on the person's whole coinage, not the current selection.
 */
import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type FilterOption = { value: string; label: string; count?: number }
/** `available`: the filter can narrow this person's coinage at all. Fixed per page, so filters
 *  don't appear and disappear as other filters change. */
export type FilterDef = { label: string; param: string; value: string | null; options: FilterOption[]; available: boolean }

/** The "With photographs" toggle (?photo=1): `count` is how many types it would leave. */
export type PhotoToggleDef = { on: boolean; count: number; available: boolean }

const ALL = "all"

/** Navigate with some parameters changed (null removes one), keeping the scroll position. */
function go(changes: Record<string, string | null>) {
  const url = new URL(window.location.href)
  for (const [param, v] of Object.entries(changes)) {
    if (v == null || v === ALL) url.searchParams.delete(param)
    else url.searchParams.set(param, v)
  }
  url.searchParams.delete("limit")
  // Handled in Base.astro: client-router navigation that keeps the scroll position.
  document.dispatchEvent(new CustomEvent("solidi:navigate-keep-scroll", { detail: url.pathname + url.search }))
}

function Filter({ label, param, value, options, allLabel }: Omit<FilterDef, "available"> & { allLabel?: string }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => go({ [param]: v })}>
      <SelectTrigger label={label} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} count={o.count?.toLocaleString("en")}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/*
 * "With photographs": a yes/no filter, so a toggle rather than a menu. Set like a filter trigger, stone until it's on,
 * then ink with a check. The count is the result of switching it on, as in a facet's menu.
 */
function PhotoToggle({ on, count }: PhotoToggleDef) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => go({ photo: on ? null : "1" })}
      className="group inline-flex items-center gap-1.5 text-ui whitespace-nowrap outline-none select-none"
    >
      <span
        aria-hidden
        className={
          on
            ? "inline-flex size-3.5 items-center justify-center bg-ink text-white"
            : "inline-flex size-3.5 items-center justify-center border border-field bg-white group-hover:border-stone"
        }
      >
        {on && <CheckIcon className="size-3" strokeWidth={2.5} />}
      </span>
      <span className={on ? "text-ink" : "text-stone group-hover:text-ink"}>With photographs</span>
      <span className="num text-stone">{count.toLocaleString("en")}</span>
    </button>
  )
}

export function CoinageFilters({ filters, photo, sort }: { filters: FilterDef[]; photo?: PhotoToggleDef; sort: string }) {
  const filtered = filters.some((f) => f.value) || !!photo?.on
  return (
    // Filters narrow the list (left); sort only reorders it (right).
    <div className="flex flex-wrap items-center justify-between gap-x-7 gap-y-2">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
        {filters
          .filter((f) => f.available || f.value)
          .map((f) => (
            <Filter key={f.param} {...f} allLabel="All" />
          ))}
        {photo && (photo.available || photo.on) && <PhotoToggle {...photo} />}
        {filtered && (
          // Clears the filters but keeps the sort.
          <Button variant="muted" onClick={() => go({ ...Object.fromEntries(filters.map((f) => [f.param, null])), photo: null })}>
            Clear filters
          </Button>
        )}
      </div>
      <Filter
        label="Sort"
        param="sort"
        value={sort}
        options={[
          { value: "earliest", label: "Earliest first" },
          { value: "latest", label: "Latest first" },
          { value: "reference", label: "By reference" },
        ]}
      />
    </div>
  )
}
