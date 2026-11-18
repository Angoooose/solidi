"""Fetch Nomisma concepts (people, mints, denominations...) and dataset metadata."""

from __future__ import annotations

from pathlib import Path

import httpx

from pipeline import sparql

DATASETS_QUERY = """
CONSTRUCT { ?d ?p ?o } WHERE { ?d a void:Dataset ; ?p ?o }
"""


def fetch(raw_dir: Path, config: dict, refresh: bool = False) -> list[Path]:
    out = raw_dir / "nomisma"
    out.mkdir(parents=True, exist_ok=True)

    dump = out / "nomisma.ttl"
    if refresh or not dump.exists():
        tmp = dump.with_suffix(".tmp")
        with httpx.stream("GET", config["dump"], timeout=900, follow_redirects=True) as r:
            r.raise_for_status()
            with tmp.open("wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
        tmp.replace(dump)

    datasets = out / "datasets.ttl"
    sparql.cached_construct(datasets, DATASETS_QUERY, refresh=refresh)
    return [dump, datasets]
