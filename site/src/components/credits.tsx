import * as React from "react"
import { cn } from "@/lib/utils"
import type { Licence } from "@/lib/format"
import { IMAGE_CREDITS_URL, type PhotoCreditItem } from "@/lib/credits"

const linkClass = "underline-offset-4 hover:text-ink hover:underline"

/** A licence's short name, linked to the licence itself when we know where it lives. */
export function LicenceLink({ licence, className }: { licence: Licence | null; className?: string }) {
  if (!licence) return <span className={className}>—</span>
  return licence.url ? (
    <a href={licence.url} rel="license noopener" className={cn(linkClass, className)}>
      {licence.label}
    </a>
  ) : (
    <span className={className}>{licence.label}</span>
  )
}

/* Up to this many collections are named; more are counted, with a link to the credits page. */
const MAX_NAMED = 4

/**
 * The credit line under any set of photographs. It picks its form from what's shown:
 *   one photo     Photograph: American Numismatic Society · Public domain
 *   a few         Photographs: ANS (Public domain); Münzkabinett Wien (CC BY-NC-SA 3.0) · Image credits
 *   many          Photographs from 14 collections · Image credits
 * Collections sharing a licence are grouped; licence names link to the licence.
 */
export function PhotoCredit({ photos, className }: { photos: PhotoCreditItem[]; className?: string }) {
  if (!photos.length) return null
  const base = cn("m-0 text-credit text-stone", className)
  const creditsLink = (
    <>
      {" · "}
      <a href={IMAGE_CREDITS_URL} className={linkClass}>
        Image credits
      </a>
    </>
  )

  if (photos.length === 1) {
    const [p] = photos
    return (
      <p className={base}>
        Photograph:{" "}
        {p.sourceUrl ? (
          <a href={p.sourceUrl} rel="noopener" className={linkClass}>
            {p.holder}
          </a>
        ) : (
          p.holder
        )}
        {p.licence && (
          <>
            {" · "}
            <LicenceLink licence={p.licence} />
          </>
        )}
      </p>
    )
  }

  // Group holders by licence, keeping the order photos appear in.
  const groups = new Map<string, { licence: Licence | null; holders: string[] }>()
  for (const p of photos) {
    const key = p.licence?.label ?? ""
    const g = groups.get(key) ?? { licence: p.licence, holders: [] }
    if (!g.holders.includes(p.holder)) g.holders.push(p.holder)
    groups.set(key, g)
  }
  const holderCount = new Set(photos.map((p) => p.holder)).size

  if (holderCount > MAX_NAMED) {
    return (
      <p className={base}>
        Photographs from {holderCount} collections
        {creditsLink}
      </p>
    )
  }

  return (
    <p className={base}>
      Photographs:{" "}
      {[...groups.values()].map((g, i) => (
        <React.Fragment key={g.licence?.label ?? "none"}>
          {i > 0 && "; "}
          {g.holders.join(", ")}
          {g.licence && (
            <>
              {" ("}
              <LicenceLink licence={g.licence} />
              {")"}
            </>
          )}
        </React.Fragment>
      ))}
      {creditsLink}
    </p>
  )
}
