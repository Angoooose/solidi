"""Small pure helpers shared across pipeline steps."""

from __future__ import annotations

import hashlib
import re

NOMISMA_ID = "http://nomisma.org/id/"


def normalise_uri(uri: str) -> str:
    """Collapse http/https, www. and trailing-slash variants of the same URI."""
    uri = uri.strip()
    uri = re.sub(r"^https?://(www\.)?", "http://", uri)
    return uri.rstrip("/")


def local_id(uri: str) -> str:
    """Last path segment after '/id/': 'http://nomisma.org/id/trajan' -> 'trajan'."""
    tail = uri.split("/id/", 1)[1] if "/id/" in uri else uri.rsplit("/", 1)[-1]
    return tail.split("#", 1)[0]


def short_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def parse_year(value: str | None) -> int | None:
    """xsd:gYear or xsd:date ('0103', '-0027', '0053-09-18') -> int year."""
    if not value:
        return None
    m = re.match(r"^\s*(-?)(\d{1,4})", value)
    if not m:
        return None
    year = int(m.group(2))
    return -year if m.group(1) else year


_RIC_LABEL = re.compile(
    r"^(RIC [IVX]+(?:\.\d)?(?:, Part \d+)?(?: \([^)]*\))?)\s+(.+?)\s+(\S+)$")


def parse_ric_label(label: str | None) -> tuple[str | None, str | None]:
    """'RIC II Trajan 147' -> ('RIC II', '147');
    'RIC II, Part 3 (second edition) Hadrian 10-11' -> ('RIC II, Part 3 (second edition)', '10-11')."""
    if not label:
        return None, None
    m = _RIC_LABEL.match(label.strip())
    if not m:
        return None, None
    return m.group(1), m.group(3)


def external_system(uri: str) -> str:
    host_map = {
        "wikidata.org": "wikidata",
        "pleiades.stoa.org": "pleiades",
        "viaf.org": "viaf",
        "vocab.getty.edu": "getty",
        "geonames.org": "geonames",
        "dbpedia.org": "dbpedia",
    }
    for host, system in host_map.items():
        if host in uri:
            return system
    return "other"


def commercial_ok(licence: str | None, rules: list[dict]) -> bool:
    if not licence:
        return False
    lowered = licence.lower()
    for rule in rules:
        if rule["match"].lower() in lowered:
            return bool(rule["commercial_ok"])
    return False


def plausible_url(url: str) -> bool:
    """Reject placeholder image links some partners publish (e.g. http://localhost:3030/...)."""
    return url.startswith(("http://", "https://")) and "://localhost" not in url and "://127.0.0.1" not in url


def plausible_weight(grams: float | None) -> float | None:
    """0 g means 'not recorded'; over 500 g is a data-entry error (largest medallions are ~200 g)."""
    if grams is None or grams <= 0 or grams > 500:
        return None
    return grams
