import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * Square, no shadow, medium weight. Hover changes colour only; nothing moves.
 *   default  ink fill            "Open the mint map"
 *   outline  hairline box        "Show more types", secondary actions
 *   ghost    wash on hover       icon buttons, toolbar actions
 *   link     ink, underline on hover (shadcn default)  "Read more", "Pleiades ↗"
 *   muted    the same link in stone                     "Clear all", "Copy link"
 * Height matches the inputs: 44px default, 36px small.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 border border-transparent text-ui font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-ink text-white hover:bg-graphite",
        outline: "border-field bg-white text-ink hover:bg-wash",
        secondary: "bg-plinth text-ink hover:bg-wash",
        ghost: "text-ink hover:bg-wash",
        link: "h-auto! border-0 p-0! text-ink underline-offset-4 hover:underline",
        muted: "h-auto! border-0 p-0! font-normal text-stone underline-offset-4 hover:text-ink hover:underline",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-3.5",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
