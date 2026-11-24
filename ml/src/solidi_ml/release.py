"""The data a run reads: one published Solidi release, downloaded once and checked.

A release is a fixed snapshot with a tag and a checksum, so a run and its train/test split can be
repeated. It holds only openly licensed data (ODbL, public domain, CC0, CC BY).
"""

from __future__ import annotations

import gzip
import hashlib
import shutil
from pathlib import Path

import httpx

REPO = "Angoooose/solidi"
RELEASE = "data-2026-11-23"   # the default snapshot; pass --release to use another
ASSET = "solidi.sqlite.gz"


def fetch(tag: str, data_dir: Path, log=print) -> Path:
    """The release's database as a local .sqlite file, downloading and verifying it if needed."""
    folder = data_dir / "release" / tag
    db = folder / "solidi.sqlite"
    if db.exists():
        return db
    folder.mkdir(parents=True, exist_ok=True)
    base = f"https://github.com/{REPO}/releases/download/{tag}/{ASSET}"
    archive = folder / ASSET
    log(f"downloading release {tag}")
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        expected = client.get(base + ".sha256").raise_for_status().text.split()[0]
        with client.stream("GET", base) as response, archive.open("wb") as out:
            response.raise_for_status()
            for chunk in response.iter_bytes(1 << 20):
                out.write(chunk)
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected:
        archive.unlink()
        raise SystemExit(f"release {tag}: checksum mismatch (expected {expected}, got {actual})")
    partial = folder / "solidi.sqlite.part"
    with gzip.open(archive, "rb") as src, partial.open("wb") as out:
        shutil.copyfileobj(src, out, 1 << 20)
    partial.rename(db)
    archive.unlink()
    return db
