"use client"

/*
 * Specimens of a coin type: a sortable, filterable table (shadcn data table on TanStack Table)
 * and a viewer dialog with previous/next.
 * Rendered as an island (client:visible); everything else on the type page is static HTML.
 */
import * as React from "react"
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { LicenceLink } from "@/components/credits"
import type { Licence } from "@/lib/format"

export type SpecimenRow = {
  id: string
  url: string
  holder: string
  identifier: string | null
  weight: number | null
  diameter: number | null
  dieAxis: number | null
  licence: Licence | null
  thumbs: { src: string; side: string }[]
  photos: { src: string; side: string }[]
}

const INITIAL_ROWS = 10
const ALL = "all"

const fmt = (n: number | null, unit = "") => (n == null ? "—" : `${n}${unit}`)
const axis = (n: number | null) => (n == null ? "—" : `${n}h`)

/* Numeric columns sort with missing values last in either direction. */
const numeric = (key: "weight" | "diameter" | "dieAxis") => (row: SpecimenRow) => row[key] ?? undefined

const columns: ColumnDef<SpecimenRow>[] = [
  { id: "photos", header: "Photos", enableSorting: false },
  { accessorKey: "holder", header: "Collection" },
  { accessorFn: (r) => r.identifier ?? undefined, id: "identifier", header: "Inventory no.", sortUndefined: "last" },
  { accessorFn: numeric("weight"), id: "weight", header: "Weight (g)", sortUndefined: "last", sortDescFirst: true },
  { accessorFn: numeric("diameter"), id: "diameter", header: "Diameter (mm)", sortUndefined: "last", sortDescFirst: true },
  { accessorFn: numeric("dieAxis"), id: "dieAxis", header: "Die axis", sortUndefined: "last" },
  { accessorKey: "licence", header: "Image licence", enableSorting: false },
  { id: "view", header: "", enableSorting: false },
]

const RIGHT = new Set(["weight", "diameter", "dieAxis"])

/*
 * Fixed column widths (px; Collection takes the rest). With automatic table layout the columns
 * resized to fit whichever ten rows were showing, so every sort shifted them.
 */
const WIDTHS: Record<string, number | undefined> = {
  photos: 168,
  identifier: 168,
  weight: 112,
  diameter: 136,
  dieAxis: 96,
  licence: 168,
  view: 88,
}


function Thumbs({ photos, size }: { photos: SpecimenRow["thumbs"]; size: number }) {
  if (!photos.length) return <span className="text-label text-stone">No photograph</span>
  return (
    <span className="flex gap-1.5">
      {photos.map((p) => (
        <img
          key={p.src}
          src={p.src}
          alt={p.side === "combined" ? "Obverse and reverse" : p.side === "obverse" ? "Obverse" : "Reverse"}
          loading="lazy"
          width={size}
          height={size}
          className={cn("object-contain mix-blend-multiply", p.side === "combined" && "w-auto")}
          style={{ height: size, width: p.side === "combined" ? size * 2 : size }}
        />
      ))}
    </span>
  )
}

export function SpecimenTable({ specimens }: { specimens: SpecimenRow[] }) {
  const anyPhotos = specimens.some((s) => s.thumbs.length)
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "weight", desc: true }])
  const [collection, setCollection] = React.useState(ALL)
  const [withPhotos, setWithPhotos] = React.useState(anyPhotos)
  const [expanded, setExpanded] = React.useState(false)
  const [open, setOpen] = React.useState<number | null>(null)

  const collections = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of specimens) counts.set(s.holder, (counts.get(s.holder) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [specimens])

  const data = React.useMemo(
    () =>
      specimens.filter(
        (s) => (collection === ALL || s.holder === collection) && (!withPhotos || s.thumbs.length > 0)
      ),
    [specimens, collection, withPhotos]
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: (u) => {
      setSorting(u)
      setOpen(null)
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const rows = table.getRowModel().rows
  const visible = expanded ? rows : rows.slice(0, INITIAL_ROWS)
  const current = open != null ? rows[open]?.original : null
  const step = (d: number) => setOpen((i) => (i == null ? i : (i + d + rows.length) % rows.length))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <Select
          value={collection}
          onValueChange={(v) => {
            setCollection(v)
            setExpanded(false)
          }}
        >
          <SelectTrigger variant="field" className="h-9" aria-label="Collection">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All collections</SelectItem>
            {collections.map(([name, n]) => (
              <SelectItem key={name} value={name} count={n}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {anyPhotos && (
          <label className="flex cursor-pointer items-center gap-2.5 text-ui">
            <Checkbox checked={withPhotos} onCheckedChange={(c) => setWithPhotos(c === true)} />
            With photographs
          </label>
        )}
      </div>

      {/* Cells keep 12px side padding; the table shifts out by the same so text lines up with the heading. */}
      <div className="-mx-3">
      <Table className="min-w-[1000px] table-fixed">
        <colgroup>
          {table.getAllLeafColumns().map((c) => (
            <col key={c.id} style={{ width: WIDTHS[c.id] }} />
          ))}
        </colgroup>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted()
                const label = flexRender(header.column.columnDef.header, header.getContext())
                return (
                  <TableHead key={header.id} className={cn(RIGHT.has(header.column.id) && "text-right")}>
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn("inline-flex items-center gap-1 hover:text-ink", sorted && "text-ink")}
                      >
                        {label}
                        {sorted === "desc" && <ArrowDownIcon className="size-3.5" />}
                        {sorted === "asc" && <ArrowUpIcon className="size-3.5" />}
                      </button>
                    ) : (
                      label
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {visible.map((row, i) => {
            const s = row.original
            const openRow = () => setOpen(i)
            return (
              <TableRow
                key={row.id}
                tabIndex={0}
                aria-label={`View ${s.holder} ${s.identifier ?? ""}`.trim()}
                onClick={openRow}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    openRow()
                  }
                }}
                className="cursor-pointer focus-visible:bg-wash focus-visible:outline-none"
              >
                <TableCell className="py-3">
                  <Thumbs photos={s.thumbs} size={64} />
                </TableCell>
                <TableCell className="whitespace-normal">{s.holder}</TableCell>
                <TableCell className="num truncate" title={s.identifier ?? undefined}>{s.identifier ?? "—"}</TableCell>
                <TableCell className="num text-right">{fmt(s.weight)}</TableCell>
                <TableCell className="num text-right">{fmt(s.diameter)}</TableCell>
                <TableCell className="num text-right">{axis(s.dieAxis)}</TableCell>
                <TableCell className="truncate text-stone" title={s.licence?.label}>
                  <span onClick={(e) => e.stopPropagation()}>
                    <LicenceLink licence={s.licence} />
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <a
                    href={s.url}
                    rel="noopener"
                    onClick={(e) => e.stopPropagation()}
                    className="underline-offset-4 hover:underline"
                  >
                    View ↗
                  </a>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      </div>

      {!rows.length && <p className="m-0 text-body text-stone">No coins match these filters.</p>}

      {!expanded && rows.length > INITIAL_ROWS && (
        <Button variant="outline" className="self-center" onClick={() => setExpanded(true)}>
          Show all {rows.length}
          {withPhotos ? " with photographs" : ""}
        </Button>
      )}

      <Dialog open={current != null} onOpenChange={(o) => !o && setOpen(null)}>
        {current && (
          <DialogContent
            showCloseButton={false}
            // Focus the viewer itself, not the first button, so opening it shows no focus ring;
            // ← and → work from here, and Tab still reaches every control.
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).focus()
            }}
            className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[860px]"
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") step(1)
              if (e.key === "ArrowLeft") step(-1)
            }}
          >
            <div className="bg-plinth">
              <div className="flex items-center justify-between px-5 pt-4">
                <span className="num text-label text-stone">
                  {open! + 1} of {rows.length}
                </span>
                <span className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Previous coin" onClick={() => step(-1)} disabled={rows.length < 2}>
                    <ChevronLeftIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Next coin" onClick={() => step(1)} disabled={rows.length < 2}>
                    <ChevronRightIcon />
                  </Button>
                  <span aria-hidden="true" className="mx-2 h-5 w-px bg-field" />
                  <DialogClose asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Close">
                      <XIcon />
                    </Button>
                  </DialogClose>
                </span>
              </div>
              <div
                className={cn(
                  "grid items-center gap-[clamp(16px,3vw,40px)] px-[clamp(20px,5vw,72px)] pt-6 pb-10",
                  current.photos.length === 2 ? "grid-cols-2" : "grid-cols-1"
                )}
              >
                {current.photos.length ? (
                  current.photos.map((p) => (
                    <img
                      key={p.src}
                      src={p.src}
                      alt={p.side === "combined" ? "Obverse and reverse" : p.side === "obverse" ? "Obverse" : "Reverse"}
                      className="aspect-square max-h-[60vh] w-full object-contain mix-blend-multiply"
                    />
                  ))
                ) : (
                  <p className="m-0 py-24 text-center text-label text-stone">No photograph of this coin</p>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-6 px-10 pt-8 pb-9">
              <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
                <div className="flex flex-col gap-1">
                  <DialogTitle className="font-serif text-heading font-normal">{current.holder}</DialogTitle>
                  <DialogDescription className="num text-label text-stone">
                    {current.identifier ?? "No inventory number"}
                  </DialogDescription>
                </div>
                <Button variant="link" asChild>
                  <a href={current.url} rel="noopener">
                    View at the museum ↗
                  </a>
                </Button>
              </div>
              <dl className="m-0 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-hairline pt-5 sm:grid-cols-4">
                {(
                  [
                    ["Weight", fmt(current.weight, " g")],
                    ["Diameter", fmt(current.diameter, " mm")],
                    ["Die axis", axis(current.dieAxis)],
                    ["Image licence", <LicenceLink licence={current.licence} />],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1">
                    <dt className="text-label text-stone">{label}</dt>
                    <dd className="num m-0">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
