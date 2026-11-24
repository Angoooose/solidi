/*
 * The facet index (src/lib/facet/index.ts) for a built database, stored in KV under
 * `facets:<built_at>` where the Worker looks for it (src/lib/facet/store.ts):
 *
 *   npm run facets:remote     ../build/solidi.sqlite, to production, after loading it into D1
 *   npm run facets -- --local ../build/trajan/solidi.sqlite
 *
 * Also written to ../build/facets.bin. Skipping this is safe: the Worker then builds the index
 * from D1 on its first coinage request and stores it itself, at the cost of a slow first page and
 * about two million rows read.
 */
import { DatabaseSync } from "node:sqlite"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildIndex, encodeIndex } from "../src/lib/facet"
import { facetKey } from "../src/lib/facet/key"

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const target = args.find((a) => a === "--local" || a === "--remote")
const path = resolve(args.find((a) => !a.startsWith("--")) ?? join(SITE, "..", "build", "solidi.sqlite"))
if (!target) throw new Error("usage: facets.ts --local|--remote [path/to/solidi.sqlite]")

const db = new DatabaseSync(path, { readOnly: true })
const index = await buildIndex(async (sql) => db.prepare(sql).all() as Record<string, unknown>[])
const bytes = encodeIndex(index)
const out = join(SITE, "..", "build", "facets.bin")
writeFileSync(out, bytes)
console.log(`${index.ids.length} types, ${(bytes.length / 1e6).toFixed(1)} MB, built ${index.builtAt} -> ${out}`)

execFileSync("npx", ["wrangler", "kv", "key", "put", "--binding", "FACETS", facetKey(index.builtAt), "--path", out, target], { cwd: SITE, stdio: "inherit" })
