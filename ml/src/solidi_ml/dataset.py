"""The data every command reads: one file, data/dataset.sqlite.

The pipeline makes it (`uv run solidi training-data`, in the repo root) and writes
build/training/dataset.sqlite.gz. Copy that into ml/data/ on the machine that trains; it is
unpacked the first time a command runs, and again whenever a newer copy is dropped in.
"""

from __future__ import annotations

import gzip
import shutil
import sqlite3
from pathlib import Path

NAME = "dataset.sqlite"


def locate(data_dir: Path, log=print) -> Path:
    """The dataset file, unpacking a newer .gz beside it first."""
    db, packed = data_dir / NAME, data_dir / (NAME + ".gz")
    if packed.exists() and (not db.exists() or packed.stat().st_mtime > db.stat().st_mtime):
        log(f"unpacking {packed}")
        partial = db.with_suffix(".part")
        with gzip.open(packed, "rb") as src, partial.open("wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
        partial.replace(db)
    if not db.exists():
        raise SystemExit(
            f"No dataset at {packed}.\n"
            "Make one where the pipeline has been built, from the repo root:\n"
            "    uv run solidi training-data\n"
            f"then copy build/training/{NAME}.gz into {data_dir}/ here.")
    return db


def describe(db_path: Path) -> str:
    """'built 2026-11-22, 45 collections': which data a report was made from."""
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    built = dict(db.execute("SELECT key, value FROM readme")).get("built_at", "")[:10]
    collections = db.execute("SELECT count(DISTINCT dataset_id) FROM specimen").fetchone()[0]
    db.close()
    return f"built {built}, {collections} collections"
