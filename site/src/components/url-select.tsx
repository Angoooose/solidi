"use client"

/*
 * A labelled select that changes one URL parameter ("Order  By region and period ⌄"). Each change
 * navigates (swapped in place by the client router, keeping the scroll position), so the server
 * renders the new view and every view can be shared.
 */
import * as React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type UrlSelectOption = { value: string; label: string; count?: number }

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
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} count={o.count?.toLocaleString("en-GB")}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
