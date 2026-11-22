/*
 * Data for the home page: the totals, the four doors (people, mints,
 * denominations, subjects: each a count, a picture and its top four), the collection tree with
 * a photo per half, and the museums whose photographs we show. Everything reads the summary
 * tables (pipeline/summaries.py).
 */
import { getCategories, getPreviews, photo, tree, type ImageCols, IMAGE_COLS_CREDITED, type Category, type Photo } from "@/lib/categories"

export type Top = { id: string; name: string; n: number }
export type DoorCoin = { id: string; name: string; diameter: number; photo: Photo | null }
export type HomeCollection = { category: Category; photo: Photo | null; children: (Category & { sub?: Category[] })[] }

export type Home = {
  types: number
  start: number | null
  end: number | null
  people: { total: number; top: Top[]; photo: Photo | null }
  mints: { total: number; top: Top[]; dots: { id: string; lon: number; lat: number; n: number }[] }
  denominations: { total: number; top: Top[]; coins: DoorCoin[] }
  subjects: { total: number; top: Top[]; photo: Photo | null }
  collections: HomeCollection[]
  holders: { total: number; top: (Top & { homepage: string | null })[] }
}

/* The two halves of the collection tree: Greek and Roman. */
const ROOTS = `(SELECT id FROM category WHERE parent_id IS NULL)`
/*
 * A door's top four: the top two of each half, so Greek coinage shows beside Rome's larger
 * numbers (Alexander III beside Constantine). `rows` gives (root, id, name, n); each shows its total.
 */
const TOP_EACH = (rows: string) => `
  SELECT id, name, total AS n FROM (
    SELECT *, row_number() OVER (PARTITION BY root ORDER BY n DESC, name) AS k, sum(n) OVER (PARTITION BY id) AS total FROM (${rows}))
  WHERE k <= 2 GROUP BY id ORDER BY n DESC, name`

export async function getHome(db: D1Database): Promise<Home> {
  const t = tree(await getCategories(db))
  const roots = t.children(null)

  const [counts, people, personPhoto, mints, dots, dens, subjects, holders] = await db.batch([
    db.prepare(`SELECT
        (SELECT count(DISTINCT person_id) FROM category_person WHERE category_id IN ${ROOTS}) AS people,
        (SELECT count(DISTINCT mint_id) FROM category_mint WHERE category_id IN ${ROOTS}) AS mints,
        (SELECT count(*) FROM denomination_stat WHERE metal_group != 'unlisted') AS denominations,
        (SELECT count(*) FROM subject_stat WHERE grp != 'unlisted') AS subjects,
        (SELECT count(*) FROM holder_stat) AS holders`),
    db.prepare(TOP_EACH(`SELECT cp.category_id AS root, p.id, p.name, cp.n FROM category_person cp JOIN person p ON p.id = cp.person_id
                         WHERE cp.category_id IN ${ROOTS}`)),
    // The most prolific person's portrait.
    db.prepare(`SELECT ${IMAGE_COLS_CREDITED} FROM category_person cp JOIN image i ON i.id = cp.image_id
                WHERE cp.category_id IN ${ROOTS} ORDER BY cp.n DESC LIMIT 1`),
    db.prepare(TOP_EACH(`SELECT cm.category_id AS root, m.id, m.name, cm.n FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                         WHERE cm.category_id IN ${ROOTS}`)),
    db.prepare(`SELECT m.id, m.lon, m.lat, sum(cm.n) AS n FROM category_mint cm JOIN mint m ON m.id = cm.mint_id
                WHERE cm.category_id IN ${ROOTS} AND m.lat IS NOT NULL AND m.lon IS NOT NULL GROUP BY m.id ORDER BY n DESC`),
    db.prepare(`SELECT t.id, t.name, s.types AS n, s.diameter, ${IMAGE_COLS_CREDITED}
                FROM (${TOP_EACH(`SELECT cd.category_id AS root, d.id, d.name, cd.n FROM category_denomination cd
                                  JOIN denomination d ON d.id = cd.denomination_id JOIN denomination_stat x ON x.denomination_id = d.id
                                  WHERE cd.category_id IN ${ROOTS} AND x.metal_group NOT IN ('unlisted', 'units')`)}) t
                JOIN denomination_stat s ON s.denomination_id = t.id LEFT JOIN image i ON i.id = s.image_id
                ORDER BY s.types DESC, t.name`),
    db.prepare(`SELECT t.id, t.name, s.types AS n, ${IMAGE_COLS_CREDITED}
                FROM (${TOP_EACH(`SELECT cs.category_id AS root, x.id, x.name, cs.n FROM category_subject cs
                                  JOIN subject x ON x.id = cs.subject_id JOIN subject_stat y ON y.subject_id = x.id
                                  WHERE cs.category_id IN ${ROOTS} AND y.grp != 'unlisted'`)}) t
                JOIN subject_stat s ON s.subject_id = t.id LEFT JOIN image i ON i.id = s.image_id
                ORDER BY s.types DESC, t.name`),
    db.prepare(`SELECT h.institution_id AS id, i.name, h.photographed AS n, i.homepage FROM holder_stat h JOIN institution i ON i.id = h.institution_id
                ORDER BY n DESC, i.name LIMIT 4`),
  ])

  const c = counts.results[0] as { people: number; mints: number; denominations: number; subjects: number; holders: number }
  type WithImage = Top & ImageCols
  const denRows = dens.results as (WithImage & { diameter: number | null })[]
  const subjectRows = subjects.results as WithImage[]
  const top = (rows: unknown[]) => (rows as Top[]).map(({ id, name, n }) => ({ id, name, n }))

  const previews = await getPreviews(db, t, roots)
  const collections = roots.map((r) => ({
    category: r,
    photo: previews.get(r.id)?.photo ?? null,
    // A middle level (Hellenistic) lists its own collections under it.
    children: t.children(r.id).map((k) => (t.isLeaf(k.id) ? k : { ...k, sub: t.children(k.id) })),
  }))

  return {
    types: roots.reduce((a, r) => a + r.types, 0),
    start: Math.min(...roots.map((r) => r.start ?? Infinity)),
    end: Math.max(...roots.map((r) => r.end ?? -Infinity)),
    people: { total: c.people, top: top(people.results), photo: photo((personPhoto.results[0] ?? {}) as WithImage) },
    mints: { total: c.mints, top: top(mints.results), dots: dots.results as Home["mints"]["dots"] },
    denominations: {
      total: c.denominations,
      top: top(denRows),
      coins: denRows.filter((d) => d.diameter != null).slice(0, 3).map((d) => ({ id: d.id, name: d.name, diameter: d.diameter!, photo: photo(d) })),
    },
    subjects: { total: c.subjects, top: top(subjectRows), photo: photo(subjectRows[0] ?? ({} as WithImage)) },
    collections,
    holders: { total: c.holders, top: holders.results as Home["holders"]["top"] },
  }
}
