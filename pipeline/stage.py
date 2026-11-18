"""Stage: load every fetched RDF file into one local Oxigraph store, and helpers to read it."""

from __future__ import annotations

import shutil
from collections import defaultdict
from pathlib import Path

import pyoxigraph as ox

NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "nmo": "http://nomisma.org/ontology#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "dcterms": "http://purl.org/dc/terms/",
    "void": "http://rdfs.org/ns/void#",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#",
    "bio": "http://purl.org/vocab/bio/0.1/",
    "org": "http://www.w3.org/ns/org#",
    "svcs": "http://rdfs.org/sioc/services#",
    "wordnet": "http://ontologi.es/WordNet/class/",
    "un": "http://www.owl-ontologies.com/Ontology1181490123.owl#",
}


def fix_predicate(pred: str) -> str:
    """Some partner datasets write 'http://nomisma.org/ontologyhasWeight' (missing '#')."""
    if pred.startswith("http://nomisma.org/ontologyhas"):
        return "http://nomisma.org/ontology#" + pred[len("http://nomisma.org/ontology"):]
    return pred


def iri(curie: str) -> str:
    prefix, local = curie.split(":", 1)
    return NS[prefix] + local


def load(files: list[Path], store_dir: Path) -> ox.Store:
    if store_dir.exists():
        shutil.rmtree(store_dir)
    store_dir.mkdir(parents=True)
    store = ox.Store(str(store_dir))
    for path in files:
        store.bulk_load(path=str(path), format=ox.RdfFormat.TURTLE, lenient=True)
    store.optimize()
    return store


class Graph:
    """Read helpers over the staged store. Values come back as plain strings."""

    def __init__(self, store: ox.Store):
        self.store = store

    def subjects_of_type(self, cls: str) -> list[str]:
        node = ox.NamedNode(iri(cls))
        rdf_type = ox.NamedNode(iri("rdf:type"))
        return sorted({q.subject.value for q in self.store.quads_for_pattern(None, rdf_type, node)
                       if isinstance(q.subject, ox.NamedNode)})

    def props(self, subject: str | ox.BlankNode) -> dict[str, list]:
        node = subject if isinstance(subject, (ox.BlankNode, ox.NamedNode)) else ox.NamedNode(subject)
        out: dict[str, list] = defaultdict(list)
        for q in self.store.quads_for_pattern(node, None, None):
            out[fix_predicate(q.predicate.value)].append(q.object)
        return out

    def exists(self, subject: str) -> bool:
        return any(True for _ in self.store.quads_for_pattern(ox.NamedNode(subject), None, None))


def first(props: dict, curie: str) -> str | None:
    vals = props.get(iri(curie))
    return vals[0].value if vals else None


def all_values(props: dict, curie: str) -> list[str]:
    return [v.value for v in props.get(iri(curie), [])]


def refs(props: dict, curie: str) -> list[str]:
    """IRIs only: concept references that are plain text are skipped."""
    return [v.value for v in props.get(iri(curie), []) if isinstance(v, ox.NamedNode)]


def nodes(props: dict, curie: str) -> list:
    return list(props.get(iri(curie), []))


def label(props: dict, curie: str = "skos:prefLabel", lang: str = "en") -> str | None:
    vals = props.get(iri(curie), [])
    for v in vals:
        if isinstance(v, ox.Literal) and v.language == lang:
            return v.value
    for v in vals:
        if isinstance(v, ox.Literal) and not v.language:
            return v.value
    return vals[0].value if vals else None
