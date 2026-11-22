import * as React from "react"

/**
 * A link off Solidi. It opens in a new tab and tells screen readers so; any visible ↗ is the
 * caller's choice, since a quiet credit line or licence name shouldn't grow arrows.
 * No rel="noopener": browsers imply it for target="_blank". Pass rel="license" where it applies.
 * Not for downloads, which would flash an empty tab.
 */
export function ExternalLink({ children, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return (
    <a {...props} target="_blank">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
