"""`solidi release`: the downloadable copy of the database, published as a GitHub release.

The built database is shared under the ODbL (OCRE's licence requires it), so the download may
only hold data whose own licence lets it be shared that way: ODbL, public domain, CC0 and CC BY.
Data under share-alike licences other than the ODbL (CC BY-SA, GFDL), non-commercial or
no-derivatives terms, or a collection's own terms stays on the site but out of the download:
types and specimens from those datasets, and the Wikipedia introductions (CC BY-SA). Which
licences qualify is `release_licences` in data/sources.yaml.

Tables that only serve the site (search indexes, page summaries, photo scores) are left out
too; the pipeline rebuilds them from what remains.

Output, in build/release/:
  solidi.sqlite.gz         the database, gzipped (the asset name stays the same every release, so
                           .../releases/latest/download/solidi.sqlite.gz always gets the newest)
  solidi.sqlite.gz.sha256  its checksum
  NOTES.md                 the release notes: licence, sources, what was left out
"""

from __future__ import annotations

import gzip
import hashlib
import re
import shutil
import sqlite3
import subprocess
from pathlib import Path

ASSET = "solidi.sqlite.gz"
SITE_URL = "https://solidi.org"

# Built for the site's pages and search; derived from the tables that stay.
SITE_ONLY = [
    "search_entity", "type_search_doc", "image_score",
    "category_stat", "category_bin", "category_facet", "category_person", "category_mint",
    "category_denomination", "category_subject", "denomination_stat", "denomination_size",
    "subject_stat", "subject_legend", "holder_stat", "catalogue_stat", "photo_source",
]
# Text under CC BY-SA: its own terms, not the ODbL's.
NOT_ODBL = ["article"]

# Tables keyed by a coin type, emptied of the types that leave.
TYPE_TABLES = [
    "legend", "type_reference", "type_match", "type_category", "type_region", "type_symbol",
    "type_denomination", "type_material", "type_person", "type_organization", "type_subject",
]


def releasable(licence: str | None, allowed: list[str]) -> bool:
    """Whether data under this licence can go into the ODbL download. Unstated never can."""
    if not licence:
        return False
    lowered = licence.lower()
    return any(a.lower() in lowered for a in allowed)


def _tables(db: sqlite3.Connection) -> set[str]:
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def slim(src: Path, out: Path, allowed: list[str]) -> dict:
    """Copy `src` to `out` without site-only tables or data the ODbL can't carry. Returns counts."""
    out.unlink(missing_ok=True)
    with sqlite3.connect(src) as s:
        s.execute("VACUUM INTO ?", (str(out),))
    db = sqlite3.connect(out)
    db.execute("PRAGMA foreign_keys = OFF")
    before = {t: db.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in ("coin_type", "specimen", "image")}

    # Search indexes (FTS5 virtual tables: dropping one drops its shadow tables).
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'").fetchall():
        db.execute(f'DROP TABLE "{name}"')
    present = _tables(db)
    for t in SITE_ONLY + NOT_ODBL:
        if t in present:
            db.execute(f'DROP TABLE "{t}"')

    datasets = db.execute("SELECT id, name, data_licence FROM dataset").fetchall()
    kept = {d for d, _, lic in datasets if releasable(lic, allowed)}
    left_out = [(name or d, lic) for d, name, lic in datasets if d not in kept]
    db.execute("CREATE TEMP TABLE kept_dataset (id TEXT PRIMARY KEY)")
    db.executemany("INSERT INTO kept_dataset VALUES (?)", [(d,) for d in kept])
    db.executescript("""
        CREATE TEMP TABLE gone_type AS SELECT id FROM coin_type WHERE dataset_id NOT IN (SELECT id FROM kept_dataset);
        CREATE TEMP TABLE gone_specimen AS
          SELECT id FROM specimen WHERE dataset_id IS NULL OR dataset_id NOT IN (SELECT id FROM kept_dataset);
        -- A specimen whose every type leaves goes with them.
        INSERT INTO gone_specimen
          SELECT specimen_id FROM specimen_type GROUP BY specimen_id
          HAVING sum(type_id NOT IN (SELECT id FROM gone_type)) = 0
          EXCEPT SELECT id FROM gone_specimen;
    """)
    present = _tables(db)
    for t in TYPE_TABLES:
        if t in present:
            db.execute(f"DELETE FROM {t} WHERE type_id IN (SELECT id FROM gone_type)")
    if "type_match" in present:
        db.execute("UPDATE type_match SET target_type_id = NULL WHERE target_type_id IN (SELECT id FROM gone_type)")
    db.executescript("""
        DELETE FROM specimen_type WHERE type_id IN (SELECT id FROM gone_type) OR specimen_id IN (SELECT id FROM gone_specimen);
        DELETE FROM image WHERE specimen_id IN (SELECT id FROM gone_specimen);
        DELETE FROM specimen WHERE id IN (SELECT id FROM gone_specimen);
        UPDATE coin_type SET parent_id = NULL WHERE parent_id IN (SELECT id FROM gone_type);
        DELETE FROM coin_type WHERE id IN (SELECT id FROM gone_type);
        DELETE FROM dataset WHERE id NOT IN (SELECT id FROM kept_dataset);
    """)

    after = {t: db.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in ("coin_type", "specimen", "image")}
    built_at = dict(db.execute("SELECT key, value FROM build_info").fetchall()).get("built_at", "")
    sources = db.execute("SELECT coalesce(name, id), data_licence FROM dataset ORDER BY name").fetchall()
    db.executescript("""
        CREATE TABLE readme (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    db.executemany("INSERT INTO readme VALUES (?, ?)", [
        ("licence", "Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/"),
        ("attribution", f"Solidi ({SITE_URL}), built on OCRE and the American Numismatic Society's Numishare "
                        "corpora, Nomisma.org and the datasets listed in the dataset table."),
        ("photographs", "The image table lists photographs by URL only. The photographs are not covered by "
                        "this licence: each stays under the terms of the collection that holds the coin."),
        ("left out", "Types and specimens whose source licence can't be shared under the ODbL (share-alike "
                     "other than the ODbL, non-commercial, no-derivatives or a collection's own terms), and "
                     "the Wikipedia introductions (CC BY-SA). The website shows them under their own terms."),
        ("built_at", built_at),
    ])
    db.commit()
    db.execute("VACUUM")
    db.close()
    return {"before": before, "after": after, "left_out": left_out, "sources": sources, "built_at": built_at}


def _gzip(path: Path, out: Path) -> None:
    with path.open("rb") as f, open(out, "wb") as raw, gzip.GzipFile(filename=path.name, mode="wb", fileobj=raw, compresslevel=9, mtime=0) as g:
        shutil.copyfileobj(f, g, 1 << 20)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def licence_label(licence: str | None) -> str:
    """'http://creativecommons.org/licenses/by-nc-sa/3.0/de/deed.en' -> 'CC BY-NC-SA 3.0'."""
    if not licence:
        return "not stated"
    low = licence.lower()
    if "odbl" in low:
        return "ODbL"
    if "cc0" in low or "publicdomain/zero" in low:
        return "CC0"
    if "publicdomain" in low or "noc-us" in low:
        return "Public domain"
    if m := re.search(r"creativecommons\.org/licenses/([a-z-]+)/(\d\.\d)", low):
        return f"CC {m[1].upper()} {m[2]}"
    if "gnu.org/licenses/fdl" in low:
        return "GNU FDL"
    return "Collection's own terms"


def _listing(rows: list[tuple[str, str]]) -> list[str]:
    """Bullets of 'name: licence', names cleaned and each pair once."""
    seen = sorted({(" ".join(name.replace("<br>", " ").split()), licence_label(lic)) for name, lic in rows})
    return [f"- {name}: {lic}" for name, lic in seen]


def notes(info: dict, size_mb: float) -> str:
    b, a = info["before"], info["after"]
    lines = [
        f"The Solidi database as SQLite, gzipped ({size_mb:.0f} MB). Built {info['built_at'][:10]}.",
        "",
        "Shared under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). "
        f"Credit Solidi ({SITE_URL}) and the sources below. The `readme` table inside says the same.",
        "",
        f"- {a['coin_type']:,} coin types, {a['specimen']:,} specimens and {a['image']:,} photographs (by URL)",
        "- Photographs stay under the terms of the collection that holds each coin.",
        "",
        "## Sources",
        "",
        *_listing(info["sources"]),
        "",
        "## Left out",
        "",
        f"Data whose licence can't be shared under the ODbL is on the website but not in this file: "
        f"{b['coin_type'] - a['coin_type']:,} types, {b['specimen'] - a['specimen']:,} specimens and the Wikipedia "
        "introductions. Sources left out:",
        "",
        *_listing(info["left_out"]),
        "",
    ]
    return "\n".join(lines)


def build_release(build_dir: Path, allowed: list[str]) -> tuple[Path, dict]:
    out_dir = build_dir / "release"
    out_dir.mkdir(parents=True, exist_ok=True)
    db_path = out_dir / "solidi.sqlite"
    info = slim(build_dir / "solidi.sqlite", db_path, allowed)
    gz = out_dir / ASSET
    _gzip(db_path, gz)
    db_path.unlink()
    (out_dir / f"{ASSET}.sha256").write_text(f"{_sha256(gz)}  {ASSET}\n")
    (out_dir / "NOTES.md").write_text(notes(info, gz.stat().st_size / 1e6))
    return out_dir, info


def publish(out_dir: Path, built_at: str) -> str:
    """Create the GitHub release `data-YYYY-MM-DD` with the file and its checksum. Returns the tag."""
    visibility = subprocess.run(["gh", "repo", "view", "--json", "visibility", "-q", ".visibility"],
                                capture_output=True, text=True, check=True).stdout.strip()
    if visibility != "PUBLIC":
        raise SystemExit(f"The repository is {visibility.lower()}: nobody else could download the release. "
                         "Make it public first.")
    tag = f"data-{built_at[:10]}"
    subprocess.run(["gh", "release", "create", tag, str(out_dir / ASSET), str(out_dir / f"{ASSET}.sha256"),
                    "--title", f"Data, {built_at[:10]}", "--notes-file", str(out_dir / "NOTES.md"), "--latest"],
                   check=True)
    return tag
