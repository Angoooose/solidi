"""Fetch a Numishare corpus (OCRE, CRRO, PELLA...) and the specimens linked to it.

The corpora's own RDF dumps time out on the server, so we page through the same
data in Nomisma's SPARQL endpoint instead. Every page is cached under build/raw.
"""

from __future__ import annotations

import re
from pathlib import Path

import pyoxigraph as ox

from pipeline import sparql

NMO = "http://nomisma.org/ontology#"
RDF_TYPE = ox.NamedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
TYPE_SERIES_ITEM = ox.NamedNode(NMO + "TypeSeriesItem")
HAS_TYPE = ox.NamedNode(NMO + "hasTypeSeriesItem")

TYPE_PAGE = 2000
SPECIMEN_PAGE = 3000

TYPES_QUERY = """
CONSTRUCT {{ ?t ?p ?o . ?s ?sp ?so . ?b ?bp ?bo }} WHERE {{
  {{ SELECT ?t WHERE {{
       ?t a nmo:TypeSeriesItem ; void:inDataset <{dataset}> . {filter}
     }} ORDER BY ?t LIMIT {limit} OFFSET {offset} }}
  {{ ?t ?p ?o }}
  UNION {{ ?t nmo:hasObverse|nmo:hasReverse ?s . ?s ?sp ?so }}
  UNION {{ ?t (nmo:hasObverse|nmo:hasReverse)? ?x . ?x ?xp ?b . FILTER(isBlank(?b)) ?b ?bp ?bo }}
}}
"""

SPECIMENS_QUERY = """
CONSTRUCT {{ ?c ?p ?o . ?s ?sp ?so . ?img ?ip ?io }} WHERE {{
  {{ SELECT DISTINCT ?c WHERE {{
       ?c nmo:hasTypeSeriesItem ?t .
       FILTER(CONTAINS(STR(?t), "{id_prefix}"))
     }} ORDER BY ?c LIMIT {limit} OFFSET {offset} }}
  {{ ?c ?p ?o }}
  UNION {{ ?c nmo:hasObverse|nmo:hasReverse ?s . ?s ?sp ?so }}
  UNION {{ ?c (nmo:hasObverse|nmo:hasReverse)?/foaf:depiction ?img . ?img ?ip ?io }}
}}
"""


# Monograms and control marks the corpus publishes as records of their own.
SYMBOLS_QUERY = """
CONSTRUCT {{ ?s ?p ?o }} WHERE {{
  ?s void:inDataset <{dataset}> ; a ?c .
  FILTER(?c IN (nmo:Monogram, <http://www.cidoc-crm.org/cidoc-crm/E37_Mark>))
  ?s ?p ?o
}}
"""


def _count_subjects(turtle: str, cls: ox.NamedNode) -> int:
    if not turtle.strip():
        return 0
    triples = ox.parse(turtle.encode("utf-8"), format=ox.RdfFormat.TURTLE, lenient=True)
    return sum(1 for t in triples if t.predicate == RDF_TYPE and t.object == cls)


def _count_linked(turtle: str) -> int:
    """Subjects with a type link: specimens, plus hoard-content groups (dcmitype:Collection)."""
    if not turtle.strip():
        return 0
    triples = ox.parse(turtle.encode("utf-8"), format=ox.RdfFormat.TURTLE, lenient=True)
    return len({t.subject for t in triples if t.predicate == HAS_TYPE})


def _type_ids(turtle: str) -> set[str]:
    triples = ox.parse(turtle.encode("utf-8"), format=ox.RdfFormat.TURTLE, lenient=True)
    return {t.subject.value for t in triples
            if t.predicate == RDF_TYPE and t.object == TYPE_SERIES_ITEM}


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)


def fetch(raw_dir: Path, corpus_key: str, corpus: dict, authority: str | None = None,
          refresh: bool = False, log=print) -> list[Path]:
    scope = f"authority-{authority}" if authority else "all"
    out = raw_dir / corpus_key / scope
    files: list[Path] = []

    # 1. Types, paged.
    filt = f"?t nmo:hasAuthority <http://nomisma.org/id/{authority}> ." if authority else ""
    type_uris: set[str] = set()
    page = 0
    while True:
        path = out / "types" / f"page-{page:04d}.ttl"
        query = TYPES_QUERY.format(dataset=corpus["dataset"], filter=filt,
                                   limit=TYPE_PAGE, offset=page * TYPE_PAGE)
        text = sparql.cached_construct(path, query, refresh=refresh)
        n = _count_subjects(text, TYPE_SERIES_ITEM)
        type_uris |= _type_ids(text)
        files.append(path)
        log(f"  {corpus_key} types page {page}: {n}")
        if n < TYPE_PAGE:
            break
        page += 1

    # 2. Symbols (monograms, control marks): one query, a few thousand at most.
    path = out / "symbols.ttl"
    sparql.cached_construct(path, SYMBOLS_QUERY.format(dataset=corpus["dataset"]), refresh=refresh)
    files.append(path)

    # 3. Specimens, grouped by type-ID prefix (sources.yaml `specimen_group`) and paged.
    # One query per type is far too slow; a couple of dozen groups is fast.
    id_path = corpus["id_path"]
    group = re.compile(corpus["specimen_group"])
    prefixes = sorted({m.group(1) for uri in type_uris if id_path in uri
                       and (m := group.match(uri.split(id_path, 1)[1]))})
    ungrouped = [u for u in type_uris if id_path in u and not group.match(u.split(id_path, 1)[1])]
    if ungrouped:
        raise ValueError(f"{len(ungrouped)} {corpus_key} type IDs match no specimen group, e.g. {ungrouped[0]}")
    log(f"  {corpus_key}: {len(type_uris)} types in {len(prefixes)} ID prefixes")
    for prefix in prefixes:
        page = 0
        while True:
            path = out / "specimens" / f"{_slug(prefix)}-{page:04d}.ttl"
            query = SPECIMENS_QUERY.format(id_prefix=id_path + prefix,
                                           limit=SPECIMEN_PAGE, offset=page * SPECIMEN_PAGE)
            text = sparql.cached_construct(path, query, refresh=refresh)
            n = _count_linked(text)
            files.append(path)
            if n < SPECIMEN_PAGE:
                log(f"  {corpus_key} specimens {prefix}: {page * SPECIMEN_PAGE + n}")
                break
            page += 1
    return files
