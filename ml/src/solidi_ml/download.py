"""Download the photos, politely and resumably.

Each photo is fetched once, shrunk to fit SIZE and saved as a JPEG named after a hash of its URL,
so a second run only fetches what is missing. A few requests at a time per host; a host that
keeps failing is given up on rather than hammered.
"""

from __future__ import annotations

import io
import json
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import httpx
from PIL import Image
from tqdm import tqdm

from .records import Photo, Specimen

USER_AGENT = "solidi-ml/0.1 (coin photo research; non-commercial)"
PER_HOST = 3              # downloads at once from one host
WORKERS = 24
TIMEOUT = 30.0
RETRIES = 3
GIVE_UP_AFTER = 40        # failures in a row before a host is skipped for the rest of the run
JPEG_QUALITY = 92


def image_path(images_dir: Path, key: str) -> Path:
    return images_dir / key[:2] / f"{key}.jpg"


class _Hosts:
    """Per-host limits: how many requests at once, and when to stop trying."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._slots: dict[str, threading.Semaphore] = {}
        self._streak: Counter[str] = Counter()
        self.dead: set[str] = set()

    def slot(self, host: str) -> threading.Semaphore:
        with self._lock:
            return self._slots.setdefault(host, threading.Semaphore(PER_HOST))

    def record(self, host: str, ok: bool) -> None:
        with self._lock:
            self._streak[host] = 0 if ok else self._streak[host] + 1
            if self._streak[host] >= GIVE_UP_AFTER:
                self.dead.add(host)


def _fetch(client: httpx.Client, hosts: _Hosts, photo: Photo, dest: Path, size: int) -> str | None:
    """Download one photo. Returns None on success, or why it failed."""
    host = urlparse(photo.url).netloc
    if host in hosts.dead:
        return "host skipped after repeated failures"
    error = "failed"
    with hosts.slot(host):
        for attempt in range(RETRIES):
            if host in hosts.dead:
                return "host skipped after repeated failures"
            try:
                response = client.get(photo.url)
                if response.status_code in (429, 500, 502, 503, 504):
                    error = f"HTTP {response.status_code}"
                    time.sleep(2.0 * (attempt + 1))
                    continue
                if response.status_code != 200:
                    error = f"HTTP {response.status_code}"
                    break
                picture = Image.open(io.BytesIO(response.content)).convert("RGB")
                picture.thumbnail((size, size), Image.Resampling.LANCZOS)
                dest.parent.mkdir(parents=True, exist_ok=True)
                partial = dest.with_suffix(".part")
                picture.save(partial, "JPEG", quality=JPEG_QUALITY)
                partial.replace(dest)
                hosts.record(host, True)
                return None
            except (httpx.HTTPError, OSError, ValueError) as exc:   # network, or not a picture
                error = type(exc).__name__
                time.sleep(1.0 * (attempt + 1))
    hosts.record(host, False)
    return error


def download(specimens: list[Specimen], data_dir: Path, size: int = 512, log=print) -> dict:
    images_dir = data_dir / "images"
    collection_of = {p.key: s.collection for s in specimens for p in s.photos}
    todo = [p for s in specimens for p in s.photos if not image_path(images_dir, p.key).exists()]
    total = len(collection_of)
    log(f"{total:,} photos wanted, {total - len(todo):,} already here, {len(todo):,} to download")
    hosts = _Hosts()
    failures: list[dict] = []
    lock = threading.Lock()

    def work(photo: Photo) -> None:
        error = _fetch(client, hosts, photo, image_path(images_dir, photo.key), size)
        with lock:
            if error:
                failures.append({"key": photo.key, "url": photo.url, "error": error,
                                 "collection": collection_of[photo.key]})
                bar.set_postfix(failed=f"{len(failures):,}", refresh=False)
            bar.update()

    # The bar shows photos done, the rate and the time left; smoothing=0 averages the whole run,
    # which is steadier than the last few seconds when hosts differ in speed.
    with (httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                       headers={"User-Agent": USER_AGENT}) as client,
          tqdm(total=len(todo), unit="photo", smoothing=0, dynamic_ncols=True,
               disable=not todo) as bar,
          ThreadPoolExecutor(WORKERS) as pool):
        list(pool.map(work, todo))

    (data_dir / "download_failures.jsonl").write_text(
        "".join(json.dumps(f) + "\n" for f in failures))
    have, wanted = defaultdict(int), defaultdict(int)
    for key, collection in collection_of.items():
        wanted[collection] += 1
        have[collection] += image_path(images_dir, key).exists()
    log("photos on disk, by collection:")
    for collection in sorted(wanted, key=wanted.get, reverse=True):
        log(f"  {collection:<12} {have[collection]:>8,} of {wanted[collection]:,}")
    if hosts.dead:
        log(f"gave up on: {', '.join(sorted(hosts.dead))}")
    return {"wanted": dict(wanted), "have": dict(have), "failed": len(failures)}
