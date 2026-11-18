import * as React from "react"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * The design rejects chips and status badges. The one badge-like element is the active-filter
 * token on the search page: a field-grey hairline box with a remove button. Use <FilterToken>
 * (components/search.tsx) for that; this stays for shadcn internals that import Badge.
 */
function Badge({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-2 border border-field px-3 py-[5px] text-label whitespace-nowrap text-ink",
        className
      )}
      {...props}
    />
  )
}

export { Badge }
