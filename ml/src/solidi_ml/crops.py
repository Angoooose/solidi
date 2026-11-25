"""Cut every photo down to its coin once, and keep the result.

Each side of each coin is saved as a small square picture in data/crops/. Finding the coin is the
slow part of preparing a photo, so doing it once makes every later step (embedding, training)
several times faster. The work is recorded photo by photo, so it can be stopped and resumed.
"""

from __future__ import annotations

import shutil
import sqlite3
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from tqdm import tqdm

from . import crop, resources
from .download import image_path
from .records import Specimen

SIZE = 448             # the side of a saved crop, px: the largest a model is trained at
JPEG_QUALITY = 88


@dataclass(frozen=True)
class View:
    """One side of one coin, cut out and saved."""
    specimen_id: str
    side: str          # 'obverse' or 'reverse'
    path: Path
    found: bool        # False when no coin was found and the whole picture was kept


def crop_path(data_dir: Path, key: str, side: str) -> Path:
    return data_dir / "crops" / key[:2] / f"{key}-{side[0]}.jpg"


def _cut(job: tuple[str, str, str, str]) -> tuple[str, list[tuple[str, bool]]]:
    """Cut one photo (runs in a helper process). Returns its key and the sides saved."""
    key, side, source, data_dir = job
    try:
        picture = Image.open(source).convert("RGB")
    except OSError:
        return key, []
    saved = []
    for name, view in crop.views_of(picture, side):
        square, found = crop.crop_coin(view)
        out = crop_path(Path(data_dir), key, name)
        out.parent.mkdir(parents=True, exist_ok=True)
        square.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(out, "JPEG", quality=JPEG_QUALITY)
        saved.append((name, found))
    return key, saved


def _index(data_dir: Path) -> sqlite3.Connection:
    """The record of what has been cut. Crops made by an older version of the cutter are thrown
    away, so pictures cut two different ways are never mixed."""
    folder = data_dir / "crops"
    db_path = folder / "index.sqlite"
    if db_path.exists():
        db = sqlite3.connect(db_path)
        version = db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
        if version and version[0] == f"{crop.VERSION}/{SIZE}":
            return db
        db.close()
        shutil.rmtree(folder)
    folder.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript("""CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                        CREATE TABLE photo (key TEXT PRIMARY KEY);
                        CREATE TABLE view (key TEXT, side TEXT, found INTEGER, PRIMARY KEY (key, side));""")
    db.execute("INSERT INTO meta VALUES ('version', ?)", (f"{crop.VERSION}/{SIZE}",))
    db.commit()
    return db


def prepare(specimens: list[Specimen], data_dir: Path, workers: int | None = None,
            log=print) -> list[View]:
    """Cut any downloaded photo not cut yet, and return every view of these specimens."""
    db = _index(data_dir)
    done = {key for key, in db.execute("SELECT key FROM photo")}
    images_dir = data_dir / "images"
    jobs = [(p.key, p.side, str(image_path(images_dir, p.key)), str(data_dir))
            for s in specimens for p in s.photos if p.key not in done]
    jobs = [job for job in jobs if Path(job[2]).exists()]
    if jobs:
        n = resources.workers(workers, heavy=False)
        log(f"cutting out the coin in {len(jobs):,} photos with {n} helper processes")
        with tqdm(total=len(jobs), unit="photo", smoothing=0, dynamic_ncols=True) as bar:
            def record(results) -> None:
                for i, (key, saved) in enumerate(results):
                    db.execute("INSERT OR IGNORE INTO photo VALUES (?)", (key,))
                    db.executemany("INSERT OR REPLACE INTO view VALUES (?, ?, ?)",
                                   [(key, side, found) for side, found in saved])
                    if i % 500 == 499:
                        db.commit()
                    bar.update()
                db.commit()
            if n:
                with ProcessPoolExecutor(n) as pool:
                    record(pool.map(_cut, jobs, chunksize=64))
            else:
                record(map(_cut, jobs))
    saved: dict[str, list[tuple[str, bool]]] = {}
    for key, side, found in db.execute("SELECT key, side, found FROM view ORDER BY key, side"):
        saved.setdefault(key, []).append((side, bool(found)))
    db.close()
    views, seen = [], set()
    for s in specimens:
        for p in s.photos:
            for side, found in saved.get(p.key, ()):
                if (s.id, side) not in seen:
                    seen.add((s.id, side))
                    views.append(View(s.id, side, crop_path(data_dir, p.key, side), found))
    return views
