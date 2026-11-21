"""Score coin photos by how good they look, so every page shows a nice one.

Two halves:

- `score_images` (the `score-images` command, run now and then): picks the candidate photos,
  downloads a small copy of each one not yet scored (politely, a few at a time per host), measures
  it and saves the measurements in a cache under build/raw/image_scores/. The thumbnails are kept
  there too, so the formula can change without downloading again. We keep measurements, never
  republish the photos.
- `load` (a build step, offline): copies the cached scores into `image_score`, which the photo
  picker (summaries.PHOTO) orders by. Photos never scored have no row and rank after scored ones.

The measurements, on a ~300px copy: how plain the background is, how much of the frame the coin
fills, whether its outline is one round coin (not two sides side by side, or a broken flan),
sharpness, contrast, and a penalty for green corrosion or murky dark surfaces.

Pilot scope ("cards"): the candidates behind the person, mint, denomination and subject photos.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import sqlite3
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import httpx

VERSION = 2
CANDIDATES = 12           # per person, mint, denomination or subject, in today's preference order
SIZE = 300                # px, the longer side of the copy we measure
PER_HOST = 3              # downloads at once from one host
WORKERS = 24
TIMEOUT = 25
USER_AGENT = "solidi-pipeline/0.1 (image quality scoring; non-commercial)"
PICTURED = 24             # summaries.PICTURED: the people and mints shown as cards


def _host_rank() -> str:
    from pipeline.summaries import _HOST_RANK
    return f"CASE {_HOST_RANK} ELSE 50 END"


def candidates(db: sqlite3.Connection) -> list[tuple[int, str]]:
    """(image id, url to fetch) for the pilot: each pictured entity's top photos by today's rule."""
    rank = _host_rank()
    live = "SELECT id FROM coin_type WHERE replaced_by_id IS NULL AND parent_id IS NULL"
    # (entity, type) pairs and the side that entity's photo is taken from.
    pools = {
        "portrait": f"""SELECT tp.person_id AS e, tp.type_id AS t, 'obverse' AS side FROM type_person tp
                      WHERE tp.role = 'portrait_obverse'
                      AND tp.person_id IN (SELECT person_id FROM category_person WHERE rank <= {PICTURED})""",
        "person": f"""SELECT tp.person_id AS e, tp.type_id AS t, 'obverse' AS side FROM type_person tp
                      WHERE tp.role IN ('authority', 'issuer')
                      AND tp.person_id IN (SELECT person_id FROM category_person WHERE rank <= {PICTURED})""",
        "mint": f"""SELECT coalesce(m.parent_id, m.id) AS e, t.id AS t, 'obverse' AS side FROM coin_type t JOIN mint m ON m.id = t.mint_id
                    WHERE coalesce(m.parent_id, m.id) IN (SELECT mint_id FROM category_mint WHERE rank <= {PICTURED})""",
        "denomination": "SELECT denomination_id AS e, type_id AS t, 'obverse' AS side FROM type_denomination",
        "subject": """SELECT ts.subject_id AS e, ts.type_id AS t, ts.side FROM type_subject ts JOIN subject_stat s ON s.subject_id = ts.subject_id
                      WHERE ts.side = CASE WHEN s.reverse >= s.obverse THEN 'reverse' ELSE 'obverse' END""",
    }
    out: dict[int, str] = {}
    for kind, pool in pools.items():
        for image_id, url in db.execute(f"""
                SELECT id, fetch_url FROM (
                  SELECT i.id, coalesce(i.iiif_service || '/full/!{SIZE},{SIZE}/0/default.jpg', i.thumbnail_url, i.url) AS fetch_url,
                    row_number() OVER (PARTITION BY p.e ORDER BY {rank}, i.iiif_service IS NULL, i.thumbnail_url IS NULL, i.id) AS k
                  FROM ({pool}) p JOIN ({live}) l ON l.id = p.t
                  JOIN coin_type v ON v.id = p.t OR v.parent_id = p.t
                  JOIN specimen_type st ON st.type_id = v.id JOIN image i ON i.specimen_id = st.specimen_id
                  WHERE i.side = p.side AND i.usable = 1)
                WHERE k <= {CANDIDATES}"""):
            out[image_id] = url
    return list(out.items())


# --- The cache ------------------------------------------------------------------------------

def _cache(raw: Path) -> tuple[sqlite3.Connection, Path]:
    root = raw / "image_scores"
    (root / "thumbs").mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "scores.sqlite", check_same_thread=False)
    db.execute("""CREATE TABLE IF NOT EXISTS score (
                    url TEXT PRIMARY KEY, status TEXT NOT NULL, version INTEGER, score REAL, features TEXT, fetched_at TEXT)""")
    return db, root / "thumbs"


def _thumb_path(thumbs: Path, url: str) -> Path:
    h = hashlib.sha1(url.encode()).hexdigest()
    return thumbs / h[:2] / f"{h}.jpg"


# --- Measuring ------------------------------------------------------------------------------

def measure(data: bytes) -> dict:
    """Measurements of one photo (bytes of any format Pillow reads), each roughly 0-1."""
    import numpy as np
    from PIL import Image, ImageFilter

    img = Image.open(io.BytesIO(data)).convert("RGB")
    img.thumbnail((SIZE, SIZE))
    rgb = np.asarray(img, dtype=np.float32)
    gray = rgb.mean(axis=2)
    h, w = gray.shape

    # The background: the four corners (a tight crop's coin touches the edges, not the corners).
    c = max(3, int(min(h, w) * 0.08))
    corners = [gray[:c, :c], gray[:c, -c:], gray[-c:, :c], gray[-c:, -c:]]
    frame = np.concatenate([x.ravel() for x in corners])
    bg = float(np.median(frame))
    # Plain: every corner smooth and alike (labels, rulers or handwriting break it).
    spread = max(float(x.std()) for x in corners) + float(np.std([x.mean() for x in corners]))
    bg_std = float(frame.std())
    plain = 1 - min(1.0, spread / 25)

    # The coin: pixels unlike the background, closed and opened to drop specks.
    mask = np.abs(gray - bg) > max(16.0, 2.5 * bg_std)
    m = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(5))
    mask = np.asarray(m) > 127
    area = mask.mean()
    if area < 0.02:
        return {"plain": round(plain, 3), "fill": 0.0, "solid": 0.0, "aspect": 0.0, "sharp": 0.0, "contrast": 0.0, "surface": 0.0}
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    # How much of the frame the coin's box fills: a tight crop is 0.5 or more.
    fill = (bw * bh) / (w * h)
    # One whole coin: how much of its box it fills (a round coin 0.79, a square one ~1, a broken
    # flan or a coin with a bite out less), and a box near square (two sides side by side ~0.5).
    solid = mask.sum() / (bw * bh)
    aspect = min(bw, bh) / max(bw, bh)

    coin = gray[mask]
    contrast = min(1.0, float(coin.std()) / 45)
    # Sharpness: the variance of a Laplacian inside the coin, on a log scale.
    lap = np.abs(4 * gray[1:-1, 1:-1] - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:])
    inner = mask[1:-1, 1:-1]
    sharp = min(1.0, math.log1p(float((lap[inner] ** 2).mean())) / 9) if inner.any() else 0.0

    # Surface: green corrosion (green above red and blue) and murky darkness.
    r, g, bl = (rgb[..., i][mask] for i in range(3))
    green = float(((g - np.maximum(r, bl)) > 8).mean())
    dark = float((coin < 60).mean())
    surface = max(0.0, 1 - 1.5 * green - 0.8 * max(0.0, dark - 0.25))

    return {"plain": round(plain, 3), "fill": round(fill, 3), "solid": round(float(solid), 3), "aspect": round(aspect, 3),
            "sharp": round(sharp, 3), "contrast": round(contrast, 3), "surface": round(surface, 3)}


def combine(f: dict) -> float:
    """One score, 0-1, from the measurements. The weights are a first guess, tuned by eye."""
    # A tight crop fills half the frame or more; less is a coin lost on a sheet.
    crop = min(1.0, f["fill"] / 0.5)
    # Solid: 0.72 or more is a whole coin of any shape; below that it falls away.
    shape = min(1.0, f["solid"] / 0.72) ** 2
    s = 0.25 * f["plain"] + 0.15 * crop + 0.15 * shape + 0.2 * f["sharp"] + 0.1 * f["contrast"] + 0.15 * f["surface"]
    # Two sides in one frame, or no coin found, can't be the photo for a card.
    if f["aspect"] < 0.6:
        s *= 0.4
    return round(max(0.0, min(1.0, s)), 4)


# --- Fetching -------------------------------------------------------------------------------

def score_images(db: sqlite3.Connection, raw: Path, log=print, limit: int | None = None) -> dict:
    cache, thumbs = _cache(raw)
    todo = candidates(db)
    done = {u for (u,) in cache.execute("SELECT url FROM score WHERE version = ? OR status = 'failed'", (VERSION,))}
    pending = [(i, u) for i, u in todo if u not in done]
    log(f"  {len(todo):,} candidates, {len(todo) - len(pending):,} cached, {len(pending):,} to fetch")
    if limit:
        pending = pending[:limit]

    locks: dict[str, threading.Semaphore] = defaultdict(lambda: threading.Semaphore(PER_HOST))
    write = threading.Lock()
    counts = defaultdict(int)
    client = httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT})
    t0 = time.time()

    def one(item: tuple[int, str]) -> None:
        _, url = item
        path = _thumb_path(thumbs, url)
        try:
            if path.exists():
                data = path.read_bytes()
            else:
                with locks[urlparse(url).netloc]:
                    resp = client.get(url)
                resp.raise_for_status()
                data = resp.content
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(data)
            f = measure(data)
            row = (url, "ok", VERSION, combine(f), json.dumps(f))
            counts["ok"] += 1
        except Exception as e:  # a dead link or an unreadable file: remember it, don't retry every run
            row = (url, "failed", VERSION, None, json.dumps({"error": type(e).__name__}))
            counts["failed"] += 1
        with write:
            cache.execute("INSERT OR REPLACE INTO score VALUES (?, ?, ?, ?, ?, datetime('now'))", row)
            n = counts["ok"] + counts["failed"]
            if n % 500 == 0:
                cache.commit()
                log(f"  {n:,}/{len(pending):,} ({counts['failed']:,} failed, {time.time() - t0:.0f}s)")

    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(one, pending))
    cache.commit()
    log(f"  scored {counts['ok']:,}, failed {counts['failed']:,} in {time.time() - t0:.0f}s")
    return dict(counts)


def rescore(raw: Path) -> int:
    """Recompute scores from the kept thumbnails after the formula changes (no downloads)."""
    cache, thumbs = _cache(raw)
    n = 0
    for (url,) in cache.execute("SELECT url FROM score WHERE status = 'ok'").fetchall():
        path = _thumb_path(thumbs, url)
        if path.exists():
            f = measure(path.read_bytes())
            cache.execute("UPDATE score SET version = ?, score = ?, features = ? WHERE url = ?", (VERSION, combine(f), json.dumps(f), url))
            n += 1
    cache.commit()
    return n


# --- The build step -------------------------------------------------------------------------

def load(db: sqlite3.Connection, raw: Path, log=print) -> int:
    """image_score from the cache, matched to this build's photos by the url we fetched."""
    db.executescript("""
        DROP TABLE IF EXISTS image_score;
        CREATE TABLE image_score (image_id INTEGER PRIMARY KEY REFERENCES image(id), score REAL NOT NULL);""")
    path = raw / "image_scores" / "scores.sqlite"
    if not path.exists():
        log("  no image scores cached (run score-images)")
        return 0
    db.execute("ATTACH DATABASE ? AS sc", (str(path),))
    n = db.execute(f"""
        INSERT INTO image_score
        SELECT i.id, s.score FROM image i
        JOIN sc.score s ON s.url = coalesce(i.iiif_service || '/full/!{SIZE},{SIZE}/0/default.jpg', i.thumbnail_url, i.url)
        WHERE s.status = 'ok' AND s.version = {VERSION}""").rowcount
    db.commit()
    db.execute("DETACH DATABASE sc")
    log(f"  {n:,} photos scored")
    return n
