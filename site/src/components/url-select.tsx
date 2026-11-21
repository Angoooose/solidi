"use client"

/*
 * A labelled select that changes one URL parameter ("Order  By region and period ⌄"). Each change
 * navigates (swapped in place by the client router, keeping the scroll position), so the server
 * renders the new view and every view can be shared.
 */
import * as React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type UrlSelectOption = {
  value: string
  /** Shown on the trigger, and in the menu unless there is a short one. */
  label: string
  /** The name in the menu under its parent ("Imperial" under Roman). */
  short?: string
  /** Nesting level in the menu: each level indents one step. */
  depth?: number
  count?: number
}

export function UrlSelect({
  label,
  param,
  value,
  options,
  path,
}: {
  label: string
  param: string
  value: string
  options: UrlSelectOption[]
  /** Navigate to this path instead of the current one (keeping the other parameters). */
  path?: string
}) {
  const go = (v: string) => {
    const url = new URL(window.location.href)
    if (path) url.pathname = path
    if (v === options[0]?.value) url.searchParams.delete(param)
    else url.searchParams.set(param, v)
    document.dispatchEvent(new CustomEvent("solidi:navigate-keep-scroll", { detail: url.pathname + url.search }))
  }
  return (
    <Select value={value} onValueChange={go}>
      <SelectTrigger label={label} aria-label={label}>
        {/* The full name on the trigger: "Roman Imperial", not the menu's "Imperial". */}
        <SelectValue>{options.find((o) => o.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            count={o.count?.toLocaleString("en-GB")}
            style={o.depth ? { paddingLeft: `calc(0.5rem + ${o.depth}rem)` } : undefined}
          >
            {o.short ?? o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
