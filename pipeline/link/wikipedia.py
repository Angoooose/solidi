"""Fetch English Wikipedia lead extracts for linked entities (CC BY-SA 4.0, attributed per article)."""

from __future__ import annotations

import json
import sqlite3
import time
from collections import Counter
from pathlib import Path
from urllib.parse import quote, unquote

import httpx

from pipeline.sources.wikidata.fetch import USER_AGENT
from pipeline.util import short_hash

SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}?redirect=true"
LICENCE = "CC BY-SA 4.0"


def _title(url: str) -> str:
    return unquote(url.rsplit("/wiki/", 1)[1])


def _summary(client: httpx.Client, cache_dir: Path, title: str, refresh: bool) -> dict | None:
    path = cache_dir / f"{short_hash(title)}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    for attempt in range(4):
        r = client.get(SUMMARY.format(title=quote(title.replace(" ", "_"), safe="")))
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", 5)))
            continue
        if r.status_code == 404:
            data = {"_missing": True}
            break
        r.raise_for_status()
        data = r.json()
        break
    else:
        return None
    cache_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    time.sleep(0.05)  # be polite
    return data


def enrich(db: sqlite3.Connection, raw_dir: Path, refresh: bool = False, log=print) -> dict:
    stats: Counter[str] = Counter()
    cache = raw_dir / "wikipedia"
    links = db.execute("SELECT entity_type, entity_id, url FROM wikipedia_link").fetchall()
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=60, follow_redirects=True) as client:
        for etype, eid, url in links:
            data = _summary(client, cache, _title(url), refresh)
            if not data or data.get("_missing"):
                stats["missing"] += 1
                continue
            if data.get("type") != "standard" or not data.get("extract"):
                stats[f"skipped ({data.get('type')})"] += 1
                continue
            db.execute("""INSERT OR REPLACE INTO article
                          (entity_type, entity_id, source, title, url, extract, revision, retrieved_at, licence)
                          VALUES (?, ?, 'wikipedia_en', ?, ?, ?, ?, ?, ?)""",
                       (etype, eid, data["title"],
                        data.get("content_urls", {}).get("desktop", {}).get("page", url),
                        data["extract"], data.get("revision"), data.get("timestamp"), LICENCE))
            stats["articles"] += 1
    db.commit()
    for k, v in sorted(stats.items()):
        log(f"  {k}: {v}")
    return dict(stats)
