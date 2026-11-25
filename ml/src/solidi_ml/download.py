"""Download the photos, politely and resumably.

Each photo is fetched once, shrunk to fit SIZE and saved as a JPEG named after a hash of its URL,
so a second run only fetches what is missing. Each host has its own small team of downloaders,
so a slow or dead host never holds up the others. A host that keeps failing is paused for a few
minutes, and given up on for the rest of the run only if repeated pauses don't help. Dropped
connections are retried; a 404 counts against the photo, not the host. Failures are appended to
download_failures.jsonl as they happen.

Certificates are checked against the operating system's store, as a browser does. Some museum
servers leave out part of their certificate chain; the system store fills the gap, and the store
bundled with Python does not.
"""

from __future__ import annotations

import io
import json
import ssl
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import httpx
import truststore
from PIL import Image
from tqdm import tqdm

from .records import Photo, Specimen

USER_AGENT = "solidi-ml/0.1 (coin photo research; non-commercial)"
PER_HOST = 3              # downloads at once from one host
TIMEOUT = httpx.Timeout(30.0, connect=10.0)
RETRIES = 3
PAUSE_AFTER = 40          # failures in a row before a host is paused
PAUSE_AFTER_UNSEEN = 9    # the same, for a host that has not yet served a single photo
PAUSE = 120.0             # seconds; the nth pause in a row lasts n times this
GIVE_UP_AFTER = 3         # pauses in a row, each followed by more failures, before a host is skipped
JPEG_QUALITY = 92
SKIPPED = "host given up on after repeated failures"

# A 404 or an unreadable file is one photo's problem. A timeout, a reset, a 403 or a 5xx may be the
# host's, and only those count against it.
_PHOTO_ONLY = (400, 404, 410, 414)


def image_path(images_dir: Path, key: str) -> Path:
    return images_dir / key[:2] / f"{key}.jpg"


class _Hosts:
    """Per-host health: a host that keeps failing is paused, and given up on if pauses don't help."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._streak: Counter[str] = Counter()     # failures in a row since the last success or pause
        self._pauses: Counter[str] = Counter()     # pauses in a row since the last success
        self._paused_until: dict[str, float] = {}
        self._served: set[str] = set()
        self.dead: set[str] = set()

    def record(self, host: str, outcome: str) -> None:
        """outcome: "ok", "bad" (the host may be at fault) or "photo" (only this photo is at fault)."""
        with self._lock:
            if outcome == "ok":
                self._served.add(host)
                self._streak[host] = 0
                self._pauses[host] = 0
            elif outcome == "bad":
                self._streak[host] += 1
                limit = PAUSE_AFTER if host in self._served else PAUSE_AFTER_UNSEEN
                if self._streak[host] >= limit:
                    self._streak[host] = 0
                    self._pauses[host] += 1
                    if self._pauses[host] >= GIVE_UP_AFTER:
                        self.dead.add(host)
                    else:
                        self._paused_until[host] = time.monotonic() + PAUSE * self._pauses[host]

    def wait(self, host: str) -> bool:
        """Block while the host is paused. False if it has been given up on."""
        while True:
            with self._lock:
                if host in self.dead:
                    return False
                remaining = self._paused_until.get(host, 0.0) - time.monotonic()
            if remaining <= 0:
                return True
            time.sleep(min(remaining, 5.0))


def _fetch(client: httpx.Client, hosts: _Hosts, photo: Photo, dest: Path, size: int) -> str | None:
    """Download one photo. Returns None on success, or why it failed."""
    host = urlparse(photo.url).netloc
    error, outcome = "failed", "bad"
    for attempt in range(RETRIES):
        if not hosts.wait(host):
            return SKIPPED
        last = attempt == RETRIES - 1
        try:
            response = client.get(photo.url)
        except httpx.ConnectError as exc:
            error = f"{type(exc).__name__}: {str(exc)[:80]}"
            if "CERTIFICATE_VERIFY_FAILED" in str(exc) or "refused" in str(exc).lower():
                break       # retrying won't change a bad certificate or a closed port
            if not last:    # an SSL EOF or a reset is a dropped connection: try a fresh one
                time.sleep(1.0 * (attempt + 1))
            continue
        except httpx.HTTPError as exc:      # timeouts, dropped connections
            error = type(exc).__name__
            if not last:
                time.sleep(1.0 * (attempt + 1))
            continue
        if response.status_code in (429, 500, 502, 503, 504):
            error = f"HTTP {response.status_code}"
            if not last:
                time.sleep(2.0 * (attempt + 1))
            continue
        if response.status_code != 200:
            error = f"HTTP {response.status_code}"
            if response.status_code in _PHOTO_ONLY:
                outcome = "photo"
            break
        try:
            picture = Image.open(io.BytesIO(response.content)).convert("RGB")
            picture.thumbnail((size, size), Image.Resampling.LANCZOS)
            dest.parent.mkdir(parents=True, exist_ok=True)
            partial = dest.with_suffix(".part")
            picture.save(partial, "JPEG", quality=JPEG_QUALITY)
            partial.replace(dest)
        except (OSError, ValueError) as exc:    # not a picture, or the disk refused it
            error, outcome = type(exc).__name__, "photo"
            break
        hosts.record(host, "ok")
        return None
    hosts.record(host, outcome)
    return error


def download(specimens: list[Specimen], data_dir: Path, size: int = 512, log=print) -> dict:
    images_dir = data_dir / "images"
    collection_of = {p.key: s.collection for s in specimens for p in s.photos}
    todo = [p for s in specimens for p in s.photos if not image_path(images_dir, p.key).exists()]
    total = len(collection_of)
    log(f"{total:,} photos wanted, {total - len(todo):,} already here, {len(todo):,} to download")
    hosts = _Hosts()
    failed = skipped = 0
    lock = threading.Lock()
    log_file = (data_dir / "download_failures.jsonl").open("w", encoding="utf-8")

    def work(photo: Photo) -> None:
        nonlocal failed, skipped
        error = _fetch(client, hosts, photo, image_path(images_dir, photo.key), size)
        with lock:
            if error == SKIPPED:        # never tried; a rerun picks it up
                skipped += 1
            elif error:
                failed += 1
                log_file.write(json.dumps({"key": photo.key, "url": photo.url, "error": error,
                                           "collection": collection_of[photo.key]}) + "\n")
                log_file.flush()
            if error:
                bar.set_postfix(failed=f"{failed:,}", skipped=f"{skipped:,}", refresh=False)
            bar.update()

    # The bar shows photos done, the rate and the time left; smoothing=0 averages the whole run,
    # which is steadier than the last few seconds when hosts differ in speed.
    by_host: dict[str, list[Photo]] = defaultdict(list)
    for photo in todo:
        by_host[urlparse(photo.url).netloc].append(photo)
    with (httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT},
                       verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as client,
          tqdm(total=len(todo), unit="photo", smoothing=0, dynamic_ncols=True,
               disable=not todo) as bar):
        pools = [ThreadPoolExecutor(PER_HOST) for _ in by_host]
        jobs = [[pool.submit(work, p) for p in photos] for pool, photos in zip(pools, by_host.values())]
        for pool in pools:
            pool.shutdown(wait=True)
        for job in (j for group in jobs for j in group):
            job.result()        # surface anything unexpected

    log_file.close()
    have, wanted = defaultdict(int), defaultdict(int)
    for key, collection in collection_of.items():
        wanted[collection] += 1
        have[collection] += image_path(images_dir, key).exists()
    log("photos on disk, by collection:")
    for collection in sorted(wanted, key=wanted.get, reverse=True):
        log(f"  {collection:<12} {have[collection]:>8,} of {wanted[collection]:,}")
    if hosts.dead:
        log(f"gave up on: {', '.join(sorted(hosts.dead))}")
    log(f"{failed:,} failed (see download_failures.jsonl), {skipped:,} skipped; rerun to retry")
    return {"wanted": dict(wanted), "have": dict(have), "failed": failed, "skipped": skipped}
