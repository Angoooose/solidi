import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { NavigationMenu as NavigationMenuPrimitive } from "radix-ui"

/*
 * shadcn NavigationMenu in the Vitrine style: header triggers look like the other nav links (stone,
 * ink on hover and when open, a hairline under the open one on the header's rule, no chevron), and
 * the panel hangs straight off the header rule: square corners, hairline border, soft shadow.
 */

function NavigationMenu({
  className,
  children,
  viewport = true,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Root> & {
  viewport?: boolean
  /** Positions the panel's wrapper; by default it hangs under the menu's left edge. */
  viewportClassName?: string
}) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      data-viewport={viewport}
      className={cn("group/navigation-menu relative flex items-center", className)}
      {...props}
    >
      {children}
      {viewport && <NavigationMenuViewport wrapperClassName={viewportClassName} />}
    </NavigationMenuPrimitive.Root>
  )
}

function NavigationMenuList({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.List>) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn("group m-0 flex list-none items-center p-0", className)}
      {...props}
    />
  )
}

function NavigationMenuItem({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Item>) {
  return <NavigationMenuPrimitive.Item data-slot="navigation-menu-item" className={cn("relative", className)} {...props} />
}

/*
 * A header nav entry. From md up the vertical padding is cancelled by negative margins so the hit
 * area fills the header and the "open"/"current" hairline lands on the header's bottom rule. On
 * phones the nav wraps, so there is no hairline: the entry is ink when open or current.
 */
const navigationMenuTriggerStyle = cva(
  "relative inline-flex items-center bg-transparent text-ui md:-my-4 md:py-4 text-stone transition-colors outline-none hover:text-ink focus-visible:text-ink data-[state=open]:text-ink data-active:text-ink after:absolute after:hidden md:after:block after:inset-x-0 after:-bottom-px after:h-px after:bg-ink after:opacity-0 data-[state=open]:after:opacity-100 data-active:after:opacity-100"
)

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Trigger>) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(navigationMenuTriggerStyle(), "border-0 font-sans", className)}
      {...props}
    >
      {children}
    </NavigationMenuPrimitive.Trigger>
  )
}

function NavigationMenuContent({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Content>) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        "top-0 left-0 w-full data-[motion^=from-]:animate-in data-[motion^=from-]:fade-in data-[motion^=to-]:animate-out data-[motion^=to-]:fade-out md:absolute md:w-auto",
        className
      )}
      {...props}
    />
  )
}

function NavigationMenuViewport({
  className,
  wrapperClassName,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Viewport> & { wrapperClassName?: string }) {
  return (
    <div className={cn("absolute top-full left-0 isolate z-50 flex justify-center", wrapperClassName)}>
      <NavigationMenuPrimitive.Viewport
        data-slot="navigation-menu-viewport"
        className={cn(
          "relative mt-px h-(--radix-navigation-menu-viewport-height) w-full origin-top overflow-hidden border border-t-0 border-hairline bg-popover text-popover-foreground shadow-[0_18px_48px_-16px_rgb(20_20_20/0.18),0_2px_6px_rgb(20_20_20/0.04)] duration-150 md:w-(--radix-navigation-menu-viewport-width) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className
        )}
        {...props}
      />
    </div>
  )
}

function NavigationMenuLink({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Link>) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      className={cn("outline-none focus-visible:outline-1 focus-visible:outline-ink", className)}
      {...props}
    />
  )
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuContent,
  NavigationMenuTrigger,
  NavigationMenuLink,
  NavigationMenuViewport,
  navigationMenuTriggerStyle,
}
