"""Fetch Wikidata facts for Nomisma concepts: links, life dates, family, Wikipedia articles.

Two cached queries:
  - every item that carries a Nomisma ID (P2950), the reverse link Wikidata curates;
  - items we only know from Nomisma's own skos matches, fetched by QID.
"""

from __future__ import annotations

import csv
import hashlib
import io
import time
from pathlib import Path

import httpx

ENDPOINT = "https://query.wikidata.org/sparql"
# Wikimedia's robot policy requires contact info in the User-Agent.
USER_AGENT = "solidi-pipeline/0.1 (https://github.com/Angoooose/solidi) python-httpx"
HEADERS = {"Accept": "text/csv", "User-Agent": USER_AGENT}

# Dates come with their precision (9 = year, 8 = decade, 7 = century...): Wikidata stores
# '5th century' as the year 500, which must not be read as an exact year.
FIELDS = """
  OPTIONAL { ?item p:P569/psv:P569 [ wikibase:timeValue ?birth ; wikibase:timePrecision ?birth_precision ] }
  OPTIONAL { ?item p:P570/psv:P570 [ wikibase:timeValue ?death ; wikibase:timePrecision ?death_precision ] }
  OPTIONAL { ?item wdt:P22 ?father }
  OPTIONAL { ?item wdt:P25 ?mother }
  OPTIONAL { ?item wdt:P26 ?spouse }
  OPTIONAL { ?item wdt:P40 ?child }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
"""

COLUMNS = "?birth ?birth_precision ?death ?death_precision ?father ?mother ?spouse ?child ?article"
BY_NOMISMA = "SELECT ?item ?nm " + COLUMNS + " WHERE { ?item wdt:P2950 ?nm ." + FIELDS + "}"
BY_QID = "SELECT ?item " + COLUMNS + " WHERE { VALUES ?item { %s }" + FIELDS + "}"
CACHE_VERSION = "v2"           # bump when the queries change, so cached answers are refetched


def _query(query: str, retries: int = 4) -> list[dict[str, str]]:
    for attempt in range(retries):
        try:
            r = httpx.get(ENDPOINT, params={"query": query}, headers=HEADERS, timeout=180)
            if r.status_code == 429:
                time.sleep(int(r.headers.get("Retry-After", 10)))
                continue
            r.raise_for_status()
            return list(csv.DictReader(io.StringIO(r.text)))
        except httpx.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Wikidata query kept being rate-limited")


def _cached(path: Path, query: str, refresh: bool) -> list[dict[str, str]]:
    if path.exists() and not refresh:
        return list(csv.DictReader(path.open(encoding="utf-8")))
    rows = _query(query)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = sorted({k for r in rows for k in r}) or ["item"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    return rows


def by_nomisma(raw_dir: Path, refresh: bool = False) -> list[dict[str, str]]:
    return _cached(raw_dir / "wikidata" / f"by_nomisma-{CACHE_VERSION}.csv", BY_NOMISMA, refresh)


def by_qids(raw_dir: Path, qids: list[str], refresh: bool = False) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    qids = sorted(set(qids))
    for i in range(0, len(qids), 200):
        batch = qids[i:i + 200]
        key = hashlib.sha1(" ".join(batch).encode()).hexdigest()[:12]
        values = " ".join(f"wd:{q}" for q in batch)
        rows += _cached(raw_dir / "wikidata" / f"by_qid-{CACHE_VERSION}-{key}.csv", BY_QID % values, refresh)
    return rows
