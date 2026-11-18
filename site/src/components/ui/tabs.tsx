import * as React from "react"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

/*
 * Vitrine tabs (ruler "Coinage" role switch, subject page): plain stone text, the active tab in ink
 * with a 1px ink rule sitting on the list's hairline. No pills, no fills.
 */
function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-8", className)}
      {...props}
    />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex w-fit items-end gap-7", className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // No focus box: tabs activate on focus (arrow keys select), so the ink underline already
        // marks the focused tab.
        "relative py-2.5 text-ui text-stone transition-colors outline-none hover:text-ink focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        "after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-ink after:opacity-0 data-[state=active]:text-ink data-[state=active]:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
