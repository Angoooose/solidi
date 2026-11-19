/*
 * Basemaps for the collection pages' mint maps: `npm run basemaps` after a database build.
 *
 * For each collection with located mints, fits a Mercator projection to its mints and writes
 *   public/maps/<category>.svg            land (Natural Earth 1:50m) clipped to the frame, a static file
 *   src/lib/basemaps.generated.json       the frame size and projection, so pages place mints on it
 * Pages draw the mints over the basemap themselves; the basemap never changes per request.
 */
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { geoMercator, geoPath } from "d3-geo"
import { feature } from "topojson-client"

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..")
const DB = join(SITE, "..", "build", "solidi.sqlite")
const BY_MINT = new Set(["archaic-classical", "hellenistic-cities", "roman-provincial"])
// Map frames: beside a mint list (kingdoms), or full width (city coinage).
const FRAME = { rulers: [940, 560], mints: [1328, 620] }
const PAD = 36

const topo = JSON.parse(readFileSync(join(SITE, "node_modules/world-atlas/land-50m.json"), "utf8"))
const land = feature(topo, topo.objects.land)

const db = new DatabaseSync(DB, { readOnly: true })
const leaves = db.prepare(`SELECT c.id FROM category c WHERE NOT EXISTS (SELECT 1 FROM category k WHERE k.parent_id = c.id)`).all()
const mintsOf = db.prepare(`SELECT m.lon, m.lat FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                            WHERE cm.category_id = ? AND m.lat IS NOT NULL AND m.lon IS NOT NULL`)

const outDir = join(SITE, "public", "maps")
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const meta = {}
for (const { id } of leaves) {
  const points = mintsOf.all(id).map((m) => [m.lon, m.lat])
  if (!points.length) continue
  const [w, h] = FRAME[BY_MINT.has(id) ? "mints" : "rulers"]
  // A lone mint or a tight cluster would zoom in to street level: frame at least 8° each way.
  const lons = points.map((p) => p[0]), lats = points.map((p) => p[1])
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2, cy = (Math.min(...lats) + Math.max(...lats)) / 2
  const frame = [...points, [cx - 4, cy - 4], [cx + 4, cy + 4]]
  const projection = geoMercator().fitExtent([[PAD, PAD], [w - PAD, h - PAD]], { type: "MultiPoint", coordinates: frame })
  projection.clipExtent([[0, 0], [w, h]])
  const d = geoPath(projection).digits(1)(land) ?? ""
  writeFileSync(join(outDir, `${id}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#F1F1EE"/>` +
    `<path d="${d}" fill="#FFFFFF" stroke="#D6D6D2" stroke-width="0.8" stroke-linejoin="round"/></svg>\n`)
  meta[id] = { width: w, height: h, scale: projection.scale(), translate: projection.translate(), center: projection.center() }
  console.log(`${id}: ${points.length} mints, ${(d.length / 1024).toFixed(0)} KB`)
}
writeFileSync(join(SITE, "src", "lib", "basemaps.generated.json"), JSON.stringify(meta, null, 1) + "\n")
