"""Summary tables for the collection pages, so the site reads tens of rows instead of scanning types.

Every count is of live types (not replaced, not a sub-variant: replaced types and sub-variants
would count some rulers twice) in their primary category, rolled up to every ancestor category.
Workshops count as their city's mint (Seleucia on the Tigris II -> Seleucia).

- category_stat    one row per category: totals for the page header and the menu
- category_bin     histogram counts, each type spread evenly over the years it may date to
- category_facet   every denomination, subject and material, with counts
- category_person  every issuing person, with counts, dates and (for the top ones) a photo
- category_mint    every mint, with counts, dates and (for the top ones) a photo
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict

BIN_WIDTHS = (10, 25)
# Photos are chosen only for the people and mints a page shows as cards.
PICTURED = 12
# Person records that stand for no one: unsigned Republican issues.
NOT_PEOPLE = ("anonymous",)

SCHEMA = """
DROP TABLE IF EXISTS category_stat;
DROP TABLE IF EXISTS category_bin;
DROP TABLE IF EXISTS category_facet;
DROP TABLE IF EXISTS category_person;
DROP TABLE IF EXISTS category_mint;
CREATE TABLE category_stat (
  category_id   TEXT PRIMARY KEY REFERENCES category(id),
  types         INTEGER NOT NULL,
  start_year    INTEGER,
  end_year      INTEGER,
  photographed  INTEGER NOT NULL,          -- types with at least one usable photo
  people        INTEGER NOT NULL,          -- issuing authorities and issuers
  mints         INTEGER NOT NULL,
  mints_located INTEGER NOT NULL,          -- mints with coordinates (their own or their city's)
  regions       INTEGER NOT NULL,
  denominations INTEGER NOT NULL,
  subjects      INTEGER NOT NULL
);
CREATE TABLE category_bin (
  category_id TEXT NOT NULL REFERENCES category(id),
  width       INTEGER NOT NULL,            -- years per bin: 10 or 25
  bin_start   INTEGER NOT NULL,            -- first year of the bin, a multiple of width (negative = BC)
  n           REAL NOT NULL,               -- types, each spread evenly over its date range
  PRIMARY KEY (category_id, width, bin_start)
);
CREATE TABLE category_facet (
  category_id TEXT NOT NULL REFERENCES category(id),
  kind        TEXT NOT NULL,               -- 'denomination', 'subject', 'material'
  entity_id   TEXT NOT NULL,
  n           INTEGER NOT NULL,
  PRIMARY KEY (category_id, kind, entity_id)
);
CREATE TABLE category_person (
  category_id TEXT NOT NULL REFERENCES category(id),
  person_id   TEXT NOT NULL REFERENCES person(id),
  n           INTEGER NOT NULL,            -- types they issued in the category
  rank        INTEGER NOT NULL,            -- 1 = most types
  start_year  INTEGER,                     -- their reign, else the span of these types
  end_year    INTEGER,
  dated_by    TEXT,                        -- 'reign', 'coins', or NULL when neither is known
  image_id    INTEGER REFERENCES image(id),-- their portrait (else an obverse of theirs), top ones only
  PRIMARY KEY (category_id, person_id)
);
CREATE TABLE category_mint (
  category_id TEXT NOT NULL REFERENCES category(id),
  mint_id     TEXT NOT NULL REFERENCES mint(id),
  n           INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  start_year  INTEGER,
  end_year    INTEGER,
  image_id    INTEGER REFERENCES image(id),-- an obverse struck there, top ones only
  PRIMARY KEY (category_id, mint_id)
);
"""

# A photo id for types matching `types` (a subquery), preferring one that has both a IIIF service
# (sharp at any size) and a thumbnail (fast in menus).
PHOTO = """
  (SELECT i.id FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
   WHERE st.type_id IN ({types}) AND i.side = 'obverse' AND i.usable = 1
   ORDER BY i.iiif_service IS NULL, i.thumbnail_url IS NULL, i.id LIMIT 1)"""


def _spread(start: int, end: int, width: int) -> list[tuple[int, float]]:
    """(bin_start, share) for a type dated start..end inclusive, spread evenly by year."""
    if start > end:
        start, end = end, start
    span = end - start + 1
    out = []
    b = (start // width) * width
    while b <= end:
        overlap = min(end, b + width - 1) - max(start, b) + 1
        out.append((b, overlap / span))
        b += width
    return out


def build(db: sqlite3.Connection, log=print) -> dict[str, int]:
    db.executescript(SCHEMA)
    not_people = ",".join(f"'{p}'" for p in NOT_PEOPLE)
    db.executescript(f"""
        DROP TABLE IF EXISTS temp.live;
        DROP TABLE IF EXISTS temp.under;
        CREATE TEMP TABLE live AS
          SELECT t.id, tc.category_id AS cat, t.start_year AS s, coalesce(t.end_year, t.start_year) AS e,
                 coalesce(m.parent_id, m.id) AS mint
          FROM coin_type t
          JOIN type_category tc ON tc.type_id = t.id AND tc.is_primary = 1
          LEFT JOIN mint m ON m.id = t.mint_id
          WHERE t.replaced_by_id IS NULL AND t.parent_id IS NULL;
        -- Each type once under its category and once under every ancestor.
        CREATE TEMP TABLE under AS
          WITH RECURSIVE up(cat, root) AS (
            SELECT id, id FROM category
            UNION ALL SELECT up.cat, c.parent_id FROM up JOIN category c ON c.id = up.root WHERE c.parent_id IS NOT NULL)
          SELECT up.root, l.* FROM live l JOIN up ON up.cat = l.cat;
        CREATE INDEX temp.idx_under_root ON under(root);
        CREATE INDEX temp.idx_under_id ON under(id);
    """)

    db.execute(f"""
        INSERT INTO category_stat
        SELECT u.root, count(*), min(u.s), max(u.e),
          sum(EXISTS (SELECT 1 FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
                      WHERE st.type_id = u.id AND i.usable = 1)),
          (SELECT count(DISTINCT tp.person_id) FROM under x JOIN type_person tp ON tp.type_id = x.id
           WHERE x.root = u.root AND tp.role IN ('authority', 'issuer') AND tp.person_id NOT IN ({not_people})),
          count(DISTINCT u.mint),
          (SELECT count(DISTINCT x.mint) FROM under x JOIN mint m ON m.id = x.mint
           WHERE x.root = u.root AND m.lat IS NOT NULL),
          (SELECT count(DISTINCT m.region_id) FROM under x JOIN mint m ON m.id = x.mint WHERE x.root = u.root),
          (SELECT count(DISTINCT td.denomination_id) FROM under x JOIN type_denomination td ON td.type_id = x.id
           WHERE x.root = u.root),
          (SELECT count(DISTINCT ts.subject_id) FROM under x JOIN type_subject ts ON ts.type_id = x.id
           WHERE x.root = u.root)
        FROM under u GROUP BY u.root""")

    bins: dict[tuple[str, int, int], float] = defaultdict(float)
    for root, s, e in db.execute("SELECT root, s, e FROM under WHERE s IS NOT NULL"):
        for width in BIN_WIDTHS:
            for b, share in _spread(s, e, width):
                bins[(root, width, b)] += share
    db.executemany("INSERT INTO category_bin VALUES (?, ?, ?, ?)",
                   [(root, w, b, round(n, 3)) for (root, w, b), n in bins.items()])

    db.executescript("""
        INSERT INTO category_facet
          SELECT u.root, 'denomination', td.denomination_id, count(DISTINCT u.id)
          FROM under u JOIN type_denomination td ON td.type_id = u.id GROUP BY 1, 3;
        INSERT INTO category_facet
          SELECT u.root, 'subject', ts.subject_id, count(DISTINCT u.id)
          FROM under u JOIN type_subject ts ON ts.type_id = u.id GROUP BY 1, 3;
        INSERT INTO category_facet
          SELECT u.root, 'material', tm.material_id, count(DISTINCT u.id)
          FROM under u JOIN type_material tm ON tm.type_id = u.id GROUP BY 1, 3;
    """)

    db.execute(f"""
        INSERT INTO category_person (category_id, person_id, n, rank, start_year, end_year, dated_by)
        WITH pc AS (
          SELECT u.root, tp.person_id AS pid, count(DISTINCT u.id) AS n, min(u.s) AS s, max(u.e) AS e
          FROM under u JOIN type_person tp ON tp.type_id = u.id
          WHERE tp.role IN ('authority', 'issuer') AND tp.person_id NOT IN ({not_people})
          GROUP BY 1, 2
        )
        SELECT pc.root, pc.pid, pc.n, row_number() OVER (PARTITION BY pc.root ORDER BY pc.n DESC, pc.pid),
          CASE WHEN p.start_year IS NOT NULL THEN p.start_year ELSE pc.s END,
          CASE WHEN p.start_year IS NOT NULL THEN coalesce(p.end_year, p.start_year) ELSE pc.e END,
          CASE WHEN p.start_year IS NOT NULL THEN 'reign' WHEN pc.s IS NOT NULL THEN 'coins' END
        FROM pc JOIN person p ON p.id = pc.pid""")
    # Their portrait on a type of theirs in the category, else any obverse of their types there.
    their = """SELECT tp.type_id FROM type_person tp JOIN under u ON u.id = tp.type_id AND u.root = cp.category_id
               WHERE tp.person_id = cp.person_id AND tp.role IN ({roles})"""
    db.execute(f"""
        UPDATE category_person AS cp SET image_id = coalesce(
          {PHOTO.format(types=their.format(roles="'portrait_obverse'"))},
          {PHOTO.format(types=their.format(roles="'authority', 'issuer'"))})
        WHERE cp.rank <= {PICTURED}""")

    db.execute("""
        INSERT INTO category_mint (category_id, mint_id, n, rank, start_year, end_year)
        SELECT u.root, u.mint, count(*), row_number() OVER (PARTITION BY u.root ORDER BY count(*) DESC, u.mint),
               min(u.s), max(u.e)
        FROM under u WHERE u.mint IS NOT NULL GROUP BY 1, 2""")
    db.execute(f"""
        UPDATE category_mint AS cm SET image_id =
          {PHOTO.format(types="SELECT u.id FROM under u WHERE u.root = cm.category_id AND u.mint = cm.mint_id")}
        WHERE cm.rank <= {PICTURED}""")
    db.commit()

    counts = {t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
              for t in ("category_stat", "category_bin", "category_facet", "category_person", "category_mint")}
    log("  " + ", ".join(f"{t} {n:,}" for t, n in counts.items()))
    return counts
