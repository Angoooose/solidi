"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react"

/*
 * The search field. Default 44px (header), hero 56px (search page).
 * Latin typed here stays in Geist: serif capitals are for Latin shown as content.
 */
export function SearchField({
  size = "default",
  shortcut,
  onClear,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & {
  size?: "default" | "hero"
  shortcut?: string
  onClear?: () => void
}) {
  const hero = size === "hero"
  return (
    <InputGroup className={cn(hero && "h-14", className)}>
      <InputGroupAddon className="text-ink">
        <SearchIcon className={hero ? "size-5" : "size-4"} strokeWidth={1.6} />
      </InputGroupAddon>
      <InputGroupInput type="search" className={cn("text-ui placeholder:text-stone", hero && "text-subtitle")} {...props} />
      {shortcut && (
        <InputGroupAddon align="inline-end">
          <Kbd>{shortcut}</Kbd>
        </InputGroupAddon>
      )}
      {onClear && (
        <InputGroupAddon align="inline-end">
          <button type="button" aria-label="Clear search" onClick={onClear} className="p-1 text-stone hover:text-ink">
            <XIcon className="size-4" />
          </button>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}

/* A collapsible group in the filter rail. */
export function FilterGroup({
  title,
  defaultOpen = true,
  children,
}: {
  title: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/fg border-t border-hairline py-3">
      <CollapsibleTrigger className="flex w-full items-center justify-between py-1 text-ui font-medium">
        {title}
        <ChevronDownIcon className="size-4 text-stone group-data-[state=open]/fg:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 pt-1.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/* One filter option: a checkbox row with a count. */
export function FilterOption({
  checked,
  onCheckedChange,
  count,
  children,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  count?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1.5 text-ui">
      <Checkbox checked={checked} onCheckedChange={(c) => onCheckedChange(c === true)} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count != null && <span className="num text-ui text-stone">{count}</span>}
    </label>
  )
}

/* An active filter, removable. */
export function FilterToken({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <Badge>
      {children}
      <button
        type="button"
        aria-label={`Remove ${typeof children === "string" ? children : "filter"}`}
        onClick={onRemove}
        className="text-stone hover:text-ink"
      >
        <XIcon className="size-3.5" />
      </button>
    </Badge>
  )
}
