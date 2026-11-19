"""Corpus Nummorum monograms: CN types cite them by API URL (data.corpus-nummorum.eu/api/monograms/840),
not by a Nomisma record. Fetch each once (cached) and write the same RDF that Numishare corpora
publish for their monograms, so the symbol step treats them alike."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import httpx

from pipeline.sources.wikidata.fetch import USER_AGENT

API = re.compile(r"https://data\.corpus-nummorum\.eu/api/monograms/(\d+)")
CRM = "http://www.cidoc-crm.org/cidoc-crm/"


def _turtle_literal(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def fetch(raw_dir: Path, source_files: list[Path], refresh: bool = False, log=print) -> list[Path]:
    ids = sorted({m.group(1) for f in source_files if f.suffix == ".ttl"
                  for m in API.finditer(f.read_text(encoding="utf-8", errors="ignore"))}, key=int)
    if not ids:
        return []
    cache = raw_dir / "cn" / "monograms"
    cache.mkdir(parents=True, exist_ok=True)
    lines = ["@prefix nmo: <http://nomisma.org/ontology#> .",
             "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .",
             f"@prefix crm: <{CRM}> ."]
    fetched = 0
    with httpx.Client(headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout=30) as client:
        for mid in ids:
            path = cache / f"{mid}.json"
            if refresh or not path.exists():
                r = client.get(f"https://data.corpus-nummorum.eu/api/monograms/{mid}")
                if r.status_code == 404:
                    path.write_text("{}")
                    continue
                r.raise_for_status()
                path.write_text(r.text, encoding="utf-8")
                fetched += 1
                time.sleep(0.1)
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
            for item in data.get("contents") or []:
                uri = f"<https://data.corpus-nummorum.eu/api/monograms/{mid}>"
                name = (item.get("name") or f"Monogram {mid}").replace("_", " ")
                lines.append(f"{uri} a nmo:Monogram ; skos:prefLabel {_turtle_literal('CN ' + name)}@en .")
                for letter in sorted(set(item.get("combination") or "")):
                    if letter.strip():
                        lines.append(f"{uri} crm:P106_is_composed_of {_turtle_literal(letter)} .")
                if item.get("download"):
                    lines.append(f"{uri} crm:P165i_is_incorporated_in <{item['download']}> .")
    out = raw_dir / "cn" / "monograms.ttl"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"  cn monograms: {len(ids)} cited ({fetched} fetched now)")
    return [out]
