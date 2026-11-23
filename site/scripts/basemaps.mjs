/*
 * Basemaps for the collection pages' mint maps: `npm run basemaps` after a database build.
 *
 * For each collection with located mints (and "all", for /mints), fits a Mercator projection to
 * its mints and writes
 *   public/maps/<category>.svg            land (Natural Earth 1:50m) and the major rivers (scripts/data/rivers.json:
 *                                         Natural Earth 1:10m, scale rank 6 and up plus the Tiber, Hebrus and
 *                                         Halys, no canals) clipped to the frame, a static file
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
const FRAME = { rulers: [940, 560], mints: [1328, 620], all: [1328, 600] }
/*
 * The all-mints map stops short of Bactria and India: a handful of mints there would shrink the
 * Mediterranean, where nearly all the rest are, to a strip. /mints says how many lie further east.
 * The mint page's locator map is a window onto this map, so it is drawn with a little margin.
 */
export const ALL_EAST = 60
const PAD = 36

const topo = JSON.parse(readFileSync(join(SITE, "node_modules/world-atlas/land-50m.json"), "utf8"))
const land = feature(topo, topo.objects.land)
// Inland mints sit on rivers (Seleucia ad Tigrim, Babylon, Carnuntum): without them an inland view is blank land.
const rivers = JSON.parse(readFileSync(join(SITE, "scripts/data/rivers.json"), "utf8"))

const db = new DatabaseSync(DB, { readOnly: true })
const categories = db.prepare(`SELECT c.id, NOT EXISTS (SELECT 1 FROM category k WHERE k.parent_id = c.id) AS leaf FROM category c`).all()
const mintsOf = db.prepare(`SELECT m.lon, m.lat FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                            WHERE cm.category_id = ? AND m.lat IS NOT NULL AND m.lon IS NOT NULL`)
const allMints = db.prepare(`SELECT DISTINCT m.lon, m.lat FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                             WHERE m.lat IS NOT NULL AND m.lon IS NOT NULL AND m.lon < ${ALL_EAST}`)

const outDir = join(SITE, "public", "maps")
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const meta = {}
const maps = [
  ...categories.map(({ id, leaf }) => ({ id, points: mintsOf.all(id), frame: leaf && !BY_MINT.has(id) ? "rulers" : "mints" })),
  { id: "all", points: allMints.all(), frame: "all" },
]
for (const { id, points: rows, frame: kind } of maps) {
  const points = rows.map((m) => [m.lon, m.lat])
  if (!points.length) continue
  const [w, h] = FRAME[kind]
  // A lone mint or a tight cluster would zoom in to street level: frame at least 8° each way.
  const lons = points.map((p) => p[0]), lats = points.map((p) => p[1])
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2, cy = (Math.min(...lats) + Math.max(...lats)) / 2
  const frame = [...points, [cx - 4, cy - 4], [cx + 4, cy + 4]]
  const projection = geoMercator().fitExtent([[PAD, PAD], [w - PAD, h - PAD]], { type: "MultiPoint", coordinates: frame })
  projection.clipExtent([[0, 0], [w, h]])
  const d = geoPath(projection).digits(1)(land) ?? ""
  const r = geoPath(projection).digits(1)(rivers) ?? ""
  writeFileSync(join(outDir, `${id}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#F1F1EE"/>` +
    `<path d="${d}" fill="#FFFFFF" stroke="#D6D6D2" stroke-width="0.8" stroke-linejoin="round"/>` +
    // Thinner and paler than the coast, so a river doesn't read as more coastline.
    `<path d="${r}" fill="none" stroke="#E2E2DE" stroke-width="0.7" stroke-linejoin="round" stroke-linecap="round"/></svg>\n`)
  meta[id] = { width: w, height: h, scale: projection.scale(), translate: projection.translate(), center: projection.center() }
  console.log(`${id}: ${points.length} mints, ${(d.length / 1024).toFixed(0)} KB`)
}
writeFileSync(join(SITE, "src", "lib", "basemaps.generated.json"), JSON.stringify(meta, null, 1) + "\n")
