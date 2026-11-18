"""Client for the Nomisma SPARQL endpoint (GET only), with on-disk caching."""

from __future__ import annotations

import csv
import io
import re
import time
from pathlib import Path

import httpx

ENDPOINT = "https://nomisma.org/query"
PREFIXES = """
PREFIX nmo: <http://nomisma.org/ontology#>
PREFIX void: <http://rdfs.org/ns/void#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
"""

_client = httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0), follow_redirects=True,
                       headers={"User-Agent": "solidi-pipeline/0.1"})


def _get(query: str, *, accept: str | None = None, output: str | None = None,
         retries: int = 4) -> str:
    params = {"query": PREFIXES + query}
    if output:
        params["output"] = output
    headers = {"Accept": accept} if accept else {}
    for attempt in range(retries):
        try:
            r = _client.get(ENDPOINT, params=params, headers=headers)
            r.raise_for_status()
            return r.text
        except httpx.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("unreachable")


def select(query: str) -> list[dict[str, str]]:
    text = _get(query, output="csv")
    return list(csv.DictReader(io.StringIO(text)))


def construct(query: str) -> str:
    return _get(query, accept="text/turtle")


_IRI = re.compile(r"<(https?://[^<>\"\n]*)>")
_BAD_IRI_CHAR = re.compile(r"\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|[\s{}|^`\\]")


def _encode(m: re.Match) -> str:
    hexcode = m.group(1) or m.group(2)
    ch = chr(int(hexcode, 16)) if hexcode else m.group(0)
    return "".join(f"%{b:02X}" for b in ch.encode("utf-8"))


def clean_turtle(text: str) -> str:
    """Percent-encode characters that are invalid in IRIs (spaces, |, {, escaped \\u0020...).

    Some partner records put free text into image URLs, which is invalid RDF.
    """
    return _IRI.sub(lambda m: "<" + _BAD_IRI_CHAR.sub(_encode, m.group(1)) + ">", text)


def cached_construct(path: Path, query: str, refresh: bool = False) -> str:
    if path.exists() and not refresh:
        return clean_turtle(path.read_text(encoding="utf-8"))
    text = clean_turtle(construct(query))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return text
