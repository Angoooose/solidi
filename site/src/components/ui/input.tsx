import * as React from "react"
import { cn } from "@/lib/utils"

/*
 * Bare boxed field: field-grey hairline, ink border on focus, no ring.
 * For the search box with an icon and ⌘K, use <SearchField> (components/search.tsx), built on InputGroup.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 border border-input bg-white px-3.5 text-ui text-ink transition-colors outline-none placeholder:text-stone focus-visible:border-ink focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&::-webkit-search-cancel-button]:appearance-none",
        className
      )}
      {...props}
    />
  )
}

export { Input }
