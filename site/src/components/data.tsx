import * as React from "react"
import { cn } from "@/lib/utils"

/* A list of facts between hairlines. */
export function DataList({ className, ...props }: React.ComponentProps<"dl">) {
  return <dl className={cn("m-0 flex flex-col border-t border-hairline", className)} {...props} />
}

/*
 * One fact: stone label, value, optional stone qualifier ("attributed", "disputed").
 * With `href`, the value is a link that underlines on hover. `action` sits at the row's end
 * (the reference row's Copy button). No chevrons, no row hover.
 */
export function DataRow({
  label,
  children,
  note,
  href,
  action,
}: {
  label: React.ReactNode
  children: React.ReactNode
  note?: React.ReactNode
  href?: string
  action?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "grid items-baseline gap-4 border-b border-hairline py-3.5",
        action ? "grid-cols-[8rem_minmax(0,1fr)_auto]" : "grid-cols-[8rem_minmax(0,1fr)]"
      )}
    >
      <dt className="text-label text-stone">{label}</dt>
      <dd className="m-0">
        {href ? <RowLink href={href}>{children}</RowLink> : children}
        {note && <span className="text-stone">, {note}</span>}
      </dd>
      {action}
    </div>
  )
}

/* A link inside a data row's value: ink, underline on hover. For rows with several links. */
export function RowLink(props: React.ComponentProps<"a">) {
  return <a {...props} className={cn("underline-offset-4 hover:underline", props.className)} />
}

/* Name … count, for ranked lists (rulers at a mint, denominations). */
export function IndexRow({ href, name, count }: { href: string; name: React.ReactNode; count: React.ReactNode }) {
  return (
    <a href={href} className="group flex items-baseline justify-between gap-4 border-b border-hairline py-2.5">
      <span className="underline-offset-4 group-hover:underline">{name}</span>
      <span className="num text-label text-stone">{count}</span>
    </a>
  )
}

/* Caption or image credit line. */
export function Credit({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("m-0 text-credit text-stone", className)} {...props} />
}
