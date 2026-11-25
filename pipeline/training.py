"""`solidi training-data`: the data the coin-identification model (ml/) is trained and tested on.

One small SQLite file, gzipped, holding every photographed coin from the collections whose licence
lets a non-commercial project train on their photos, with the type each coin belongs to and the
descriptions and labels of those types. Which collections qualify is `training` in
data/sources.yaml.

Unlike `solidi release`, this file includes collections under non-commercial licences, so it is
not for publishing: copy it to the machine that trains. Weights trained on it must be shared
under CC BY-NC-SA 4.0, crediting the collections in its dataset table.

Output: build/training/dataset.sqlite.gz
"""

from __future__ import annotations

import gzip
import shutil
import sqlite3
from pathlib import Path

from pipeline.release import releasable

NAME = "dataset.sqlite"

# The tables and columns ml/ reads.
COLUMNS = {
    "dataset": "id, slug, name, data_licence, image_licence",
    "coin_type": "id, dataset_id, mint_id, obv_description, rev_description, obv_legend, rev_legend",
    "type_person": "type_id, person_id, role",
    "type_denomination": "type_id, denomination_id",
    "specimen": "id, dataset_id",
    "specimen_type": "specimen_id, type_id",
    "image": "specimen_id, side, url, iiif_service",
}


def usable(dataset_id: str, licence: str | None, policy: dict) -> tuple[bool, str]:
    """Whether a collection's photos may be trained on, and why not if not."""
    for key, prefix in (("excluded", ""), ("unconfirmed", "licence not confirmed: ")):
        if dataset_id in (policy.get(key) or {}):
            return False, prefix + policy[key][dataset_id]
    if releasable(licence, policy["licences"]):
        return True, ""
    return False, "licence does not allow it" if licence else "no licence stated"


def build_training(build_dir: Path, policy: dict) -> tuple[Path, dict]:
    """Write build/training/dataset.sqlite.gz. Returns its path and what went in and stayed out."""
    src = build_dir / "solidi.sqlite"
    if not src.exists():
        raise SystemExit(f"{src} not found: run `solidi build` first")
    out_dir = build_dir / "training"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / NAME
    out.unlink(missing_ok=True)
    db = sqlite3.connect(out)
    db.execute("ATTACH DATABASE ? AS full", (str(src.resolve()),))   # only read from

    verdicts = {d: (name or d, *usable(d, licence, policy))
                for d, name, licence in db.execute("SELECT id, name, data_licence FROM full.dataset")}
    db.execute("CREATE TEMP TABLE kept (id TEXT PRIMARY KEY)")
    db.executemany("INSERT INTO kept VALUES (?)", [(d,) for d, (_, ok, _) in verdicts.items() if ok])
    # Photographed coins of the kept collections, and only the types those coins belong to.
    db.executescript(f"""
        CREATE TABLE specimen AS SELECT {COLUMNS['specimen']} FROM full.specimen
          WHERE dataset_id IN (SELECT id FROM kept) AND id IN (SELECT specimen_id FROM full.image);
        CREATE TABLE specimen_type AS SELECT {COLUMNS['specimen_type']} FROM full.specimen_type
          WHERE specimen_id IN (SELECT id FROM specimen);
        CREATE TABLE image AS SELECT {COLUMNS['image']} FROM full.image
          WHERE specimen_id IN (SELECT id FROM specimen);
        CREATE TABLE coin_type AS SELECT {COLUMNS['coin_type']} FROM full.coin_type
          WHERE id IN (SELECT type_id FROM specimen_type);
        CREATE TABLE type_person AS SELECT {COLUMNS['type_person']} FROM full.type_person
          WHERE type_id IN (SELECT id FROM coin_type);
        CREATE TABLE type_denomination AS SELECT {COLUMNS['type_denomination']} FROM full.type_denomination
          WHERE type_id IN (SELECT id FROM coin_type);
        -- Collections with coins here, and the catalogues their types come from (for the slug).
        CREATE TABLE dataset AS SELECT {COLUMNS['dataset']} FROM full.dataset
          WHERE id IN (SELECT dataset_id FROM specimen) OR id IN (SELECT dataset_id FROM coin_type);
        CREATE INDEX image_specimen ON image(specimen_id);
        CREATE INDEX specimen_type_specimen ON specimen_type(specimen_id);
        CREATE TABLE readme (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    built_at = dict(db.execute("SELECT key, value FROM full.build_info")).get("built_at", "")
    coins = dict(db.execute("SELECT dataset_id, count(*) FROM specimen GROUP BY 1"))
    db.executemany("INSERT INTO readme VALUES (?, ?)", [
        ("built_at", built_at),
        ("use", "Training data for the Solidi coin-identification model. Includes collections under "
                "non-commercial licences: do not publish this file."),
        ("weights", "Weights trained on this data must be shared under CC BY-NC-SA 4.0, crediting the "
                    "collections in the dataset table, and may not be used commercially."),
        ("photographs", "The image table lists photographs by URL only; each stays under its "
                        "collection's terms."),
    ])
    db.commit()
    db.execute("DETACH DATABASE full")
    db.execute("VACUUM")
    db.close()

    packed = out_dir / (NAME + ".gz")
    with out.open("rb") as raw, gzip.open(packed, "wb", compresslevel=6) as gz:
        shutil.copyfileobj(raw, gz, 1 << 20)
    out.unlink()
    info = {
        "built_at": built_at,
        "used": sorted(((verdicts[d][0], n) for d, n in coins.items()), key=lambda r: -r[1]),
        "left_out": sorted((name, why) for name, ok, why in verdicts.values() if not ok),
    }
    return packed, info
