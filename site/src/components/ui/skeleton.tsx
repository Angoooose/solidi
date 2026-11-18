import { cn } from "@/lib/utils"

/* Plinth-coloured blocks, still (the search grid's loading rows don't pulse). */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("block bg-plinth", className)}
      {...props}
    />
  )
}

export { Skeleton }
