/*
 * Fills the page_summary table (src/lib/summary/) in a built database, so `solidi export-d1`
 * ships it to D1 with the rest:
 *
 *   npm run summaries                                  ../build/solidi.sqlite
 *   npm run summaries -- ../build/trajan/solidi.sqlite
 *
 * Run it after `solidi build` and before `solidi export-d1`. It runs the pages' own queries
 * (src/lib/summary/*.ts) against the file, through a small stand-in for the D1 API. Skipping it is
 * safe: without the table, pages run those queries against D1 on each request instead.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SCHEMA, SUMMARIES } from "../src/lib/summary"

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..")
const path = resolve(process.argv[2] ?? join(SITE, "..", "build", "solidi.sqlite"))
const db = new DatabaseSync(path)

/* The part of D1's API the summaries use. D1 binds `?1` by number; node:sqlite only binds
 * numbered parameters by name, so they become `:p1`. */
const cache = new Map<string, StatementSync>()
function statement(sql: string, args: unknown[] = []) {
  const numbered = /\?\d+/.test(sql)
  const text = numbered ? sql.replace(/\?(\d+)/g, ":p$1") : sql
  const run = () => {
    let s = cache.get(text)
    if (!s) cache.set(text, (s = db.prepare(text)))
    const params = numbered ? [Object.fromEntries(args.map((v, i) => [`p${i + 1}`, v]))] : args
    return s.all(...(params as never[]))
  }
  return {
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => ({ results: run(), success: true, meta: {} }),
    first: async () => run()[0] ?? null,
  }
}
const d1 = {
  prepare: (sql: string) => statement(sql),
  batch: (statements: ReturnType<typeof statement>[]) => Promise.all(statements.map((s) => s.all())),
} as unknown as D1Database

const started = Date.now()
db.exec(`DROP TABLE IF EXISTS page_summary; ${SCHEMA};`)
const insert = db.prepare(`INSERT INTO page_summary (kind, id, data) VALUES (?, ?, ?)`)
let bytes = 0
for (const [kind, { ids, load }] of Object.entries(SUMMARIES)) {
  const rows = db.prepare(ids).all() as { id: string }[]
  db.exec("BEGIN")
  for (const { id } of rows) {
    const data = JSON.stringify(await load(d1, id))
    // export-d1 writes each row as one INSERT, and D1 rejects statements over 100 KB.
    if (Buffer.byteLength(data) > 90_000) throw new Error(`page_summary ${kind}/${id} is ${Buffer.byteLength(data)} bytes, over D1's statement limit`)
    bytes += Buffer.byteLength(data)
    insert.run(kind, id, data)
  }
  db.exec("COMMIT")
  console.log(`${kind}: ${rows.length}`)
}
db.close()
console.log(`page_summary: ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${path}`)
