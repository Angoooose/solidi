"""Tables for the site's ⌘K search palette.

- search_entity      every person, mint, collection, denomination and subject with a page, with
                     what its row shows: dates, a type count, a photo or coordinates (mints).
                     Small enough (a few thousand rows) for the site to send to the browser whole.
- type_search_doc    one row per catalogue reference of every live type, as search terms and the
                     number on its own, with what orders the results
- type_search        FTS5 index over type_search_doc: 'RIC II 22', 'trajan 2', 'rrc 494/23'

Query text is normalised the same way on the site (src/lib/searchQuery.ts): keep the two in step.
A Roman numeral in a query matches either form ('ii' OR '2'), so 'RIC II 22' and 'Philip II 1' both work.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata

from pipeline.summaries import NOT_PEOPLE, photo

SCHEMA = """
DROP TABLE IF EXISTS search_entity;
DROP TABLE IF EXISTS type_search;
DROP TABLE IF EXISTS type_search_doc;
CREATE TABLE search_entity (
  kind        TEXT NOT NULL,               -- 'person', 'mint', 'collection', 'denomination', 'subject'
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  context     TEXT,                        -- mint: its region; collection: its parent collection;
                                           -- denomination: its main metal
  start_year  INTEGER,                     -- person: reign, else the span of their types
  end_year    INTEGER,
  n           INTEGER NOT NULL,            -- live types
  image_id    INTEGER REFERENCES image(id),-- person: a portrait; others: a coin of it
  lat         REAL,                        -- mint: its coordinates, or its city's
  lon         REAL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE type_search_doc (
  id          INTEGER PRIMARY KEY,
  type_id     TEXT NOT NULL REFERENCES coin_type(id),
  terms       TEXT NOT NULL,               -- normalised citation, catalogue aliases, people's names
  num         TEXT NOT NULL,               -- the number within the catalogue, normalised: '22', '494/23'
  child       INTEGER NOT NULL,            -- a sub-variant: listed after its parent's number
  start_year  INTEGER,
  sort_key    TEXT NOT NULL
);
CREATE VIRTUAL TABLE type_search USING fts5(terms, num, content='type_search_doc', content_rowid='id',
                                            tokenize="unicode61 tokenchars './'", prefix='1 2 3');
"""

# Other names people use for a catalogue, beyond what its citations already say.
WORK_ALIASES = {
    "rrc": "crawford",
    "seleucid_coins": "sc",
    "coins_ptolemaic_empire": "cpe svoronos",
    "price1991": "price",
    "lerider_philip_ii": "le rider",
    "bigr": "bigr",
}

ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10,
         "xi": 11, "xii": 12, "xiii": 13}


def tokens(text: str) -> list[str]:
    """'RIC II, Part 3 (second edition) Hadrian 101' -> ['ric', 'ii', 'part', '3', ...]. Lower case,
    no accents; letters, digits, and '.' or '/' inside a number ('494/23', '2.3')."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return [t for t in (t.strip("./") for t in re.sub(r"[^a-z0-9./]+", " ", text).split()) if t]


def index_terms(label: str, volume: str | None) -> list[str]:
    """A citation's search terms: its tokens, plus the volume in Arabic numerals ('RIC II' -> '2')
    and a RIC part as volume.part ('RIC II, Part 3' -> '2.3'). Only the volume: 'Philip II' stays
    'ii', so 'RIC 2 22' doesn't also find Valerian II's 22."""
    out = tokens(label)
    m = volume and re.match(r"RIC ([IVX]+)(?:, Part (\d+))?", volume)
    if m:
        vol = ROMAN[m.group(1).lower()]
        out += [str(vol)] + ([f"{vol}.{m.group(2)}"] if m.group(2) else [])
    return out


def build(db: sqlite3.Connection, log=print) -> dict[str, int]:
    db.executescript(SCHEMA)
    not_people = ",".join(f"'{p}'" for p in NOT_PEOPLE)
    db.executescript("""
        DROP TABLE IF EXISTS temp.live_type;
        CREATE TEMP TABLE live_type AS
          SELECT id, start_year AS s, coalesce(end_year, start_year) AS e, mint_id FROM coin_type
          WHERE replaced_by_id IS NULL AND parent_id IS NULL;
        CREATE INDEX temp.idx_live_type ON live_type(id);
    """)

    # People: every one with a live type, in any role (their page lists all of them).
    db.execute(f"""
        INSERT INTO search_entity (kind, id, name, start_year, end_year, n)
        SELECT 'person', p.id, p.name,
          CASE WHEN p.start_year IS NOT NULL THEN p.start_year ELSE min(l.s) END,
          CASE WHEN p.start_year IS NOT NULL THEN coalesce(p.end_year, p.start_year) ELSE max(l.e) END,
          count(DISTINCT l.id)
        FROM person p JOIN type_person tp ON tp.person_id = p.id JOIN live_type l ON l.id = tp.type_id
        WHERE p.id NOT IN ({not_people})
        GROUP BY p.id""")
    their = """SELECT tp.type_id FROM type_person tp JOIN live_type l ON l.id = tp.type_id
               WHERE tp.person_id = e.id AND tp.role IN ({roles})"""
    db.execute(f"""
        UPDATE search_entity AS e SET image_id = coalesce(
          {photo(their.format(roles="'portrait_obverse'"))},
          {photo(their.format(roles="'authority', 'issuer'"))})
        WHERE e.kind = 'person'""")

    # Mints: cities, with their workshops' types (a workshop's page redirects to its city).
    db.execute("""
        INSERT INTO search_entity (kind, id, name, context, start_year, end_year, n, lat, lon)
        SELECT 'mint', c.id, c.name, r.name, min(l.s), max(l.e), count(*), c.lat, c.lon
        FROM live_type l JOIN mint m ON m.id = l.mint_id JOIN mint c ON c.id = coalesce(m.parent_id, m.id)
        LEFT JOIN region r ON r.id = c.region_id
        GROUP BY c.id""")

    # Collections: a coin of the most prolific person (else mint) that has a photo.
    db.execute("""
        INSERT INTO search_entity (kind, id, name, context, start_year, end_year, n, image_id)
        SELECT 'collection', c.id, c.name, p.name, s.start_year, s.end_year, s.types, coalesce(
          (SELECT image_id FROM category_person WHERE category_id = c.id AND image_id IS NOT NULL ORDER BY rank LIMIT 1),
          (SELECT image_id FROM category_mint WHERE category_id = c.id AND image_id IS NOT NULL ORDER BY rank LIMIT 1))
        FROM category c JOIN category_stat s ON s.category_id = c.id LEFT JOIN category p ON p.id = c.parent_id""")

    # Denominations and subjects listed on /denominations and /subjects ('unlisted' ones aren't real:
    # 'Uncertain value'), with the photo their pages lead with.
    db.execute("""
        INSERT INTO search_entity (kind, id, name, context, start_year, end_year, n, image_id)
        SELECT 'denomination', d.id, d.name, m.name, s.start_year, s.end_year, s.types, s.image_id
        FROM denomination d JOIN denomination_stat s ON s.denomination_id = d.id
        LEFT JOIN material m ON m.id = s.material_id
        WHERE s.metal_group != 'unlisted'""")
    db.execute("""
        INSERT INTO search_entity (kind, id, name, start_year, end_year, n, image_id)
        SELECT 'subject', s.id, s.name, x.start_year, x.end_year, x.types, x.image_id
        FROM subject s JOIN subject_stat x ON x.subject_id = s.id
        WHERE x.grp != 'unlisted'""")

    # Catalogue references of every type that has a page (sub-variants too: RIC II.3 numbers them).
    names: dict[str, list[str]] = {}
    for type_id, name in db.execute(
            "SELECT tp.type_id, p.name FROM type_person tp JOIN person p ON p.id = tp.person_id "
            "WHERE tp.role IN ('authority', 'issuer', 'stated_authority')"):
        names.setdefault(type_id, []).append(name)
    rows = []
    for type_id, work, label, volume, number, sort_key, child, start in db.execute("""
            SELECT r.type_id, r.work_id, r.label, r.volume, r.number, r.sort_key, t.parent_id IS NOT NULL, t.start_year
            FROM type_reference r JOIN coin_type t ON t.id = r.type_id
            WHERE t.replaced_by_id IS NULL"""):
        terms = index_terms(label, volume)
        for name in names.get(type_id, []):
            terms += tokens(name)
        terms += WORK_ALIASES.get(work, "").split()
        num = tokens(number or "") or tokens(label)[-1:]
        if not num:
            continue
        rows.append((type_id, " ".join(dict.fromkeys(terms)), " ".join(num), child, start, sort_key))
    db.executemany("INSERT INTO type_search_doc (type_id, terms, num, child, start_year, sort_key) "
                   "VALUES (?, ?, ?, ?, ?, ?)", rows)
    db.execute("INSERT INTO type_search (type_search) VALUES ('rebuild')")
    db.commit()

    counts = {f"{kind}s": n for kind, n in db.execute("SELECT kind, count(*) FROM search_entity GROUP BY kind")}
    counts["references"] = len(rows)
    log("  " + ", ".join(f"{k} {n:,}" for k, n in counts.items()))
    return counts
