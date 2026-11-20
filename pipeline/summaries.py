"""Summary tables for the collection pages, so the site reads tens of rows instead of scanning types.

Every count is of live types (not replaced, not a sub-variant: replaced types and sub-variants
would count some rulers twice) in their primary category, rolled up to every ancestor category.
Workshops count as their city's mint (Seleucia on the Tigris II -> Seleucia).

- category_stat    one row per category: totals for the page header and the menu
- category_bin     histogram counts, each type spread evenly over the years it may date to
- category_facet   every denomination, subject and material, with counts
- category_person  every issuing person, with counts, dates and (for the top ones) a photo
- category_mint    every mint, with counts, dates, 25-year histogram and (for the top ones) a photo
- category_denomination  every denomination, with counts, dates, histogram, sizes, weights and a photo
- denomination_stat      one row per denomination: its metal, totals and sizes for the list and its page
- denomination_size      for a denomination's top collections, the denominations struck beside it, by size
"""

from __future__ import annotations

import json
import re
import sqlite3
import statistics
from collections import defaultdict

BIN_WIDTHS = (10, 25)
MINT_BIN = 25
# Photos are chosen only for the people and mints a page shows as cards.
PICTURED = 24
# Person records that stand for no one: unsigned Republican issues.
NOT_PEOPLE = ("anonymous",)

# Denominations by metal: each goes under its most common material's group. Billon (debased silver)
# reads as silver; copper alloys, lead and iron as bronze.
METAL_GROUP = {"av": "gold", "el": "electrum", "ar": "silver", "billon": "silver", "ae": "bronze",
               "cu": "bronze", "orichalcum": "bronze", "cupro-nickel": "bronze", "pb": "bronze", "fe": "bronze"}
# A second material is named ("also silver") when at least this share of the types use it.
ALSO_SHARE = 0.1
# The catalogues' placeholder names for bronzes whose ancient name is unknown (AE3, 4 unit,
# Denomination C, Uncertain value): grouped together rather than under a metal.
CATALOGUE_UNIT = re.compile(r"^(AE(\d|\b)|(Large|Small|Reduced|Light|Heavy) AE|Denomination\b|Uncertain value$|Fraction$|Silver$)|\bunits?\b", re.I)
# Specimen measurements outside these are typos (a 2,740 mm coin).
DIAMETER_MM = (4, 80)
WEIGHT_G = (0.05, 500)
# A denomination's page compares it with what its top collections struck at the same time.
SIZE_COLLECTIONS = 3
SIZE_OTHERS = 5
SIZE_MIN_MEASURED = 5

SCHEMA = """
DROP TABLE IF EXISTS category_stat;
DROP TABLE IF EXISTS category_bin;
DROP TABLE IF EXISTS category_facet;
DROP TABLE IF EXISTS category_person;
DROP TABLE IF EXISTS category_mint;
DROP TABLE IF EXISTS category_denomination;
DROP TABLE IF EXISTS denomination_stat;
DROP TABLE IF EXISTS denomination_size;
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
  coins_start INTEGER,                     -- the span of these types: earliest year any may date to
  coins_end   INTEGER,                     -- (can run past the reign: posthumous and joint issues)
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
  bins        TEXT,                        -- JSON [[bin_start, n], …]: 25-year bins, as category_bin
  PRIMARY KEY (category_id, mint_id)
);
CREATE TABLE category_denomination (
  category_id     TEXT NOT NULL REFERENCES category(id),
  denomination_id TEXT NOT NULL REFERENCES denomination(id),
  n               INTEGER NOT NULL,
  rank            INTEGER NOT NULL,
  start_year      INTEGER,
  end_year        INTEGER,
  bins            TEXT,                    -- JSON [[bin_start, n], …]: 25-year bins
  diameter        REAL,                    -- median of measured specimens, mm
  diameter_n      INTEGER NOT NULL,
  weight          REAL,                    -- median of weighed specimens, g
  weight_n        INTEGER NOT NULL,
  image_id        INTEGER REFERENCES image(id), -- an obverse, from a holder whose photos are cropped tight
  PRIMARY KEY (category_id, denomination_id)
);
CREATE TABLE denomination_stat (
  denomination_id TEXT PRIMARY KEY REFERENCES denomination(id),
  metal_group     TEXT NOT NULL,           -- 'gold', 'electrum', 'silver', 'bronze', or 'units' (catalogue units)
  material_id     TEXT REFERENCES material(id), -- its most common material
  also_id         TEXT REFERENCES material(id), -- a second one used by a real share of its types
  types           INTEGER NOT NULL,
  start_year      INTEGER,
  end_year        INTEGER,
  bins            TEXT,
  collections     INTEGER NOT NULL,        -- leaf categories
  people          INTEGER NOT NULL,
  mints           INTEGER NOT NULL,
  subjects        INTEGER NOT NULL,
  specimens       INTEGER NOT NULL,
  holders         INTEGER NOT NULL,
  diameter        REAL,
  diameter_n      INTEGER NOT NULL,
  weight          REAL,
  weight_n        INTEGER NOT NULL,
  image_id        INTEGER REFERENCES image(id)
);
CREATE TABLE denomination_size (
  denomination_id TEXT NOT NULL REFERENCES denomination(id),
  category_id     TEXT NOT NULL REFERENCES category(id), -- one of its top leaf collections
  tab             INTEGER NOT NULL,        -- 1 = the collection with most of its types
  window_start    INTEGER,                 -- the middle 80% of its dates there
  window_end      INTEGER,
  other_id        TEXT NOT NULL REFERENCES denomination(id), -- itself, or one struck there in that window
  diameter        REAL NOT NULL,           -- median of those measured in the window
  diameter_n      INTEGER NOT NULL,
  PRIMARY KEY (denomination_id, category_id, other_id)
);
"""

# Holders whose photos are tightly cropped on a plain ground, best first: they read well as cards.
# Others follow; Princeton's IIIF images are whole-sheet scans with the coin small in the frame.
PHOTO_HOSTS = ("numismatics.org", "britishmuseum.org", "ikmk.smb.museum", "corpus-nummorum.eu",
               "ashmus.ox.ac.uk", "khm.at", "fitzmuseum.cam.ac.uk")
LAST_HOSTS = ("princeton.edu",)
_HOST_RANK = " ".join(f"WHEN i.url LIKE '%{h}%' THEN {n}" for n, h in enumerate(PHOTO_HOSTS)) + \
    " " + " ".join(f"WHEN i.url LIKE '%{h}%' THEN 99" for h in LAST_HOSTS)

# A photo id for types matching `types` (a subquery): a preferred holder first, then one with both
# a IIIF service (sharp at any size) and a thumbnail (fast in menus).
PHOTO = f"""
  (SELECT i.id FROM specimen_type st JOIN image i ON i.specimen_id = st.specimen_id
   WHERE st.type_id IN ({{types}}) AND i.side = 'obverse' AND i.usable = 1
   ORDER BY CASE {_HOST_RANK} ELSE 50 END, i.iiif_service IS NULL, i.thumbnail_url IS NULL, i.id LIMIT 1)"""


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
        INSERT INTO category_person (category_id, person_id, n, rank, start_year, end_year, dated_by, coins_start, coins_end)
        WITH pc AS (
          -- The coins' span leaves out types dated wholly before the person was born: misattributions
          -- in the source (SC 607, of Antiochus II, is filed under Antiochus III).
          SELECT u.root, tp.person_id AS pid, count(DISTINCT u.id) AS n,
            min(CASE WHEN b.birth_year IS NULL OR u.e >= b.birth_year THEN u.s END) AS s,
            max(CASE WHEN b.birth_year IS NULL OR u.e >= b.birth_year THEN u.e END) AS e
          FROM under u JOIN type_person tp ON tp.type_id = u.id JOIN person b ON b.id = tp.person_id
          WHERE tp.role IN ('authority', 'issuer') AND tp.person_id NOT IN ({not_people})
          GROUP BY 1, 2
        )
        SELECT pc.root, pc.pid, pc.n, row_number() OVER (PARTITION BY pc.root ORDER BY pc.n DESC, pc.pid),
          CASE WHEN p.start_year IS NOT NULL THEN p.start_year ELSE pc.s END,
          CASE WHEN p.start_year IS NOT NULL THEN coalesce(p.end_year, p.start_year) ELSE pc.e END,
          CASE WHEN p.start_year IS NOT NULL THEN 'reign' WHEN pc.s IS NOT NULL THEN 'coins' END,
          pc.s, pc.e
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
    # Each mint's histogram (the mints list's sparklines), kept as a small JSON column rather than
    # a row per bin: the list reads every mint's at once.
    mint_bins: dict[tuple[str, str], dict[int, float]] = defaultdict(lambda: defaultdict(float))
    for root, mint, s, e in db.execute("SELECT root, mint, s, e FROM under WHERE mint IS NOT NULL AND s IS NOT NULL"):
        for b, share in _spread(s, e, MINT_BIN):
            mint_bins[(root, mint)][b] += share
    db.executemany("UPDATE category_mint SET bins = ? WHERE category_id = ? AND mint_id = ?",
                   [(json.dumps([[b, round(n, 2)] for b, n in sorted(bins.items())], separators=(",", ":")), root, mint)
                    for (root, mint), bins in mint_bins.items()])
    db.execute(f"""
        UPDATE category_mint AS cm SET image_id =
          {PHOTO.format(types="SELECT u.id FROM under u WHERE u.root = cm.category_id AND u.mint = cm.mint_id")}
        WHERE cm.rank <= {PICTURED}""")
    _denominations(db)
    db.commit()

    counts = {t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
              for t in ("category_stat", "category_bin", "category_facet", "category_person", "category_mint",
                        "category_denomination", "denomination_stat", "denomination_size")}
    log("  " + ", ".join(f"{t} {n:,}" for t, n in counts.items()))
    return counts


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def _bins_json(spans: list[tuple[int, int]]) -> str | None:
    bins: dict[int, float] = defaultdict(float)
    for s, e in spans:
        for b, share in _spread(s, e, MINT_BIN):
            bins[b] += share
    return json.dumps([[b, round(n, 2)] for b, n in sorted(bins.items())], separators=(",", ":")) if bins else None


def _denominations(db: sqlite3.Connection) -> None:
    """category_denomination, denomination_stat and denomination_size (uses build's temp tables)."""
    not_people = ",".join(f"'{p}'" for p in NOT_PEOPLE)
    # Every live type with a denomination: (root category, denomination, type, years, leaf category).
    rows = db.execute("""SELECT u.root, td.denomination_id, u.id, u.s, u.e, u.cat
                         FROM under u JOIN type_denomination td ON td.type_id = u.id""").fetchall()
    # Measurements per type: (specimen, holder, weight, diameter).
    measured: dict[str, list[tuple]] = defaultdict(list)
    for tid, sid, holder, w, d in db.execute("""
            SELECT st.type_id, s.id, s.institution_id, s.weight_g, s.diameter_mm
            FROM specimen_type st JOIN specimen s ON s.id = st.specimen_id
            WHERE st.type_id IN (SELECT type_id FROM type_denomination)"""):
        w = w if w is not None and WEIGHT_G[0] <= w <= WEIGHT_G[1] else None
        d = d if d is not None and DIAMETER_MM[0] <= d <= DIAMETER_MM[1] else None
        measured[tid].append((sid, holder, w, d))

    def sizes(types) -> tuple[list[float], list[float]]:
        seen, ws, ds = set(), [], []
        for t in types:
            for sid, _, w, d in measured.get(t, ()):
                if sid in seen:
                    continue
                seen.add(sid)
                if w is not None:
                    ws.append(w)
                if d is not None:
                    ds.append(d)
        return ws, ds

    # Per category and denomination.
    groups: dict[tuple[str, str], list[tuple]] = defaultdict(list)
    for root, den, tid, s, e, leaf in rows:
        groups[(root, den)].append((tid, s, e, leaf))
    out = []
    for (root, den), ts in groups.items():
        ws, ds = sizes(t[0] for t in ts)
        dated = [(s, e) for _, s, e, _ in ts if s is not None]
        out.append((root, den, len(ts), min((s for s, _ in dated), default=None), max((e for _, e in dated), default=None),
                    _bins_json(dated), _median(ds), len(ds), _median(ws), len(ws)))
    db.executemany("""INSERT INTO category_denomination
                      (category_id, denomination_id, n, rank, start_year, end_year, bins, diameter, diameter_n, weight, weight_n)
                      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)""", out)
    db.execute("""UPDATE category_denomination AS cd SET rank = (
                    SELECT count(*) FROM category_denomination x WHERE x.category_id = cd.category_id
                    AND (x.n > cd.n OR (x.n = cd.n AND x.denomination_id < cd.denomination_id))) + 1""")
    db.execute(f"""
        UPDATE category_denomination AS cd SET image_id =
          {PHOTO.format(types="SELECT u.id FROM under u JOIN type_denomination td ON td.type_id = u.id WHERE u.root = cd.category_id AND td.denomination_id = cd.denomination_id")}""")

    # Per denomination, across every collection (each type once).
    by_den: dict[str, dict[str, tuple]] = defaultdict(dict)
    for root, den, tid, s, e, leaf in rows:
        by_den[den][tid] = (s, e, leaf)
    names = dict(db.execute("SELECT id, name FROM denomination"))
    materials = defaultdict(list)
    for den, mat, n in db.execute("""SELECT td.denomination_id, tm.material_id, count(*) FROM type_denomination td
                                     JOIN live l ON l.id = td.type_id JOIN type_material tm ON tm.type_id = td.type_id
                                     GROUP BY 1, 2 ORDER BY 3 DESC, 2"""):
        materials[den].append((mat, n))
    counts = {den: (c, p, m, sj) for den, c, p, m, sj in db.execute(f"""
        SELECT td.denomination_id, count(DISTINCT l.cat),
          (SELECT count(DISTINCT tp.person_id) FROM type_denomination x JOIN live y ON y.id = x.type_id
           JOIN type_person tp ON tp.type_id = x.type_id
           WHERE x.denomination_id = td.denomination_id AND tp.role IN ('authority', 'issuer') AND tp.person_id NOT IN ({not_people})),
          count(DISTINCT l.mint),
          (SELECT count(DISTINCT ts.subject_id) FROM type_denomination x JOIN live y ON y.id = x.type_id
           JOIN type_subject ts ON ts.type_id = x.type_id WHERE x.denomination_id = td.denomination_id)
        FROM type_denomination td JOIN live l ON l.id = td.type_id GROUP BY 1""")}
    stat = []
    for den, types in by_den.items():
        mats = materials.get(den, [])
        total = sum(n for _, n in mats)
        material = mats[0][0] if mats else None
        also = next((m for m, n in mats[1:] if n >= ALSO_SHARE * total), None)
        group = "units" if CATALOGUE_UNIT.search(names[den]) else METAL_GROUP.get(material or "", "bronze")
        specimens = {sid for t in types for sid, *_ in measured.get(t, ())}
        holders = {h for t in types for _, h, *_ in measured.get(t, ()) if h}
        ws, ds = sizes(types)
        dated = [(s, e) for s, e, _ in types.values() if s is not None]
        c, p, m, sj = counts[den]
        stat.append((den, group, material, also, len(types), min((s for s, _ in dated), default=None),
                     max((e for _, e in dated), default=None), _bins_json(dated), c, p, m, sj,
                     len(specimens), len(holders), _median(ds), len(ds), _median(ws), len(ws)))
    db.executemany(f"INSERT INTO denomination_stat VALUES ({','.join('?' * 18)}, NULL)", stat)
    db.execute(f"""
        UPDATE denomination_stat AS ds SET image_id =
          {PHOTO.format(types="SELECT td.type_id FROM type_denomination td JOIN live l ON l.id = td.type_id WHERE td.denomination_id = ds.denomination_id")}""")

    # Size comparisons: in each of its top leaf collections, the window holding the middle 80% of
    # its types' dates, and the denominations most struck there in that window.
    leaf_types: dict[str, dict[str, list[tuple]]] = defaultdict(lambda: defaultdict(list))
    for den, types in by_den.items():
        for tid, (s, e, leaf) in types.items():
            leaf_types[leaf][den].append((tid, s, e))
    size = []
    for den, types in by_den.items():
        per_leaf: dict[str, int] = defaultdict(int)
        for _, _, leaf in types.values():
            per_leaf[leaf] += 1
        tops = sorted(per_leaf, key=lambda c: (-per_leaf[c], c))[:SIZE_COLLECTIONS]
        tab = 0
        for leaf in tops:
            mids = sorted((s + e) / 2 for _, s, e in leaf_types[leaf][den] if s is not None)
            if mids:
                lo, hi = mids[int(0.1 * (len(mids) - 1))], mids[int(round(0.9 * (len(mids) - 1)))]
                lo, hi = int(5 * round(lo / 5)), int(5 * round(hi / 5))
                inside = lambda s, e: s is not None and s <= hi and e >= lo
            else:
                lo = hi = None
                inside = lambda s, e: True
            candidates = []
            for other, ots in leaf_types[leaf].items():
                these = [tid for tid, s, e in ots if inside(s, e)]
                if not these:
                    continue
                _, ds = sizes(these)
                if len(ds) >= SIZE_MIN_MEASURED:
                    candidates.append((other != den, -len(these), other, _median(ds), len(ds)))
            candidates.sort()
            if not candidates or candidates[0][0]:
                continue  # the denomination itself is unmeasured here
            tab += 1
            for _, _, other, d, n in candidates[:SIZE_OTHERS + 1]:
                size.append((den, leaf, tab, lo, hi, other, d, n))
    db.executemany("INSERT INTO denomination_size VALUES (?, ?, ?, ?, ?, ?, ?, ?)", size)
