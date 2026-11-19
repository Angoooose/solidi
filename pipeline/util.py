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
    # Types OCRE split by denomination end in a qualifier: 'RIC II Trajan 22 (aureus)'.
    m = _RIC_LABEL.match(re.sub(r"\s+\([^()]*\)$", "", label.strip()))
    if not m:
        return None, None
    return m.group(1), m.group(3)


_LOCAL_NOMISMA = re.compile(r"^https?://localhost(?::\d+)?/fuseki/nomisma/([A-Za-z0-9_.\-]+)$")


def repair_uri(uri: str) -> str:
    """Some partners publish Nomisma IDs as links into their own local copy of Nomisma
    ('http://localhost:8080/fuseki/nomisma/aristai_athens'): point them back at Nomisma."""
    m = _LOCAL_NOMISMA.match(uri)
    return NOMISMA_ID + m.group(1) if m else uri


def is_nomisma(uri: str) -> bool:
    return normalise_uri(uri).startswith(normalise_uri(NOMISMA_ID))


def entity_id(uri: str, source: str) -> str:
    """Nomisma concepts keep their slug ('trajan'): Nomisma is the shared registry.
    Anything else is prefixed with its source ('cn/monogram.840') so IDs never collide."""
    return local_id(uri) if source == "nomisma" else f"{source}/{local_id(uri)}"


_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def _roman(text: str) -> int | None:
    if not text or set(text) - set(_ROMAN_VALUES):
        return None
    total = 0
    for i, ch in enumerate(text):
        v = _ROMAN_VALUES[ch]
        total += -v if i + 1 < len(text) and _ROMAN_VALUES[text[i + 1]] > v else v
    return total


def natural_key(text: str | None) -> str:
    """Sortable form: numbers zero-padded, Roman volume numerals as numbers.
    'RIC II, Part 3' < 'RIC X'; '9' < '10' < '10a'."""
    if not text:
        return ""
    out = []
    for token in re.findall(r"\d+|[A-Za-z]+|[^\dA-Za-z]+", text):
        if token.isdigit():
            out.append(f"{int(token):08d}")
        elif (n := _roman(token)) is not None and token.isupper():
            out.append(f"{n:08d}")
        else:
            out.append(token.lower())
    return "".join(out)


def parse_reference(work: str, label: str | None) -> tuple[str | None, str | None]:
    """(volume, number) from a type's catalogue label. RIC labels carry a volume and the
    issuer's name ('RIC II Trajan 147'); other catalogues end in the number ('RRC 414/1',
    'Price 153', 'Seleucid Coins (part 1) 1043.3')."""
    if not label:
        return None, None
    if work == "ric":
        return parse_ric_label(label)
    m = re.search(r"\s(\S*\d\S*)$", label.strip())
    return None, (m.group(1) if m else None)


def reference_sort_key(volume: str | None, number: str | None) -> str:
    """Volume padded with spaces so a shorter volume sorts first ('RIC II' before
    'RIC II, Part 3'): every printable character sorts after a space."""
    vol = natural_key(volume)
    if len(vol) > 80:
        raise ValueError(f"volume too long to sort: {volume!r}")
    return f"{vol:<80}|{natural_key(number)}"


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
