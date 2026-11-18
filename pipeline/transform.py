"""Link and build: turn the staged RDF graph into the canonical SQLite database."""

from __future__ import annotations

import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pyoxigraph as ox

from pipeline.stage import Graph, all_values, first, iri, label, nodes, refs
from pipeline.util import (
    commercial_ok, external_system, local_id, normalise_uri, parse_ric_label, parse_year,
    plausible_url, plausible_weight, short_hash,
)

SCHEMA = Path(__file__).with_name("schema.sql")
UNCERTAIN = "http://nomisma.org/id/uncertain_value"

PERSON = iri("foaf:Person")
ORGANIZATION = iri("foaf:Organization")
DEITY = iri("wordnet:Deity")


class Builder:
    def __init__(self, graph: Graph, db_path: Path, config: dict, log=print):
        self.g = graph
        self.config = config
        self.log = log
        self.warnings: Counter[str] = Counter()
        if db_path.exists():
            db_path.unlink()
        self.db = sqlite3.connect(db_path)
        self.db.executescript(SCHEMA.read_text())
        self._concepts: dict[str, dict] = {}
        self.redirects: dict[str, str] = {}
        self._inserted: dict[str, set[str]] = {k: set() for k in
                                                ("person", "organization", "mint", "denomination", "material",
                                                 "subject", "institution", "dataset")}

    # -- helpers -------------------------------------------------------------

    def concept(self, uri: str) -> dict:
        if uri not in self._concepts:
            self._concepts[uri] = self.g.props(uri)
        return self._concepts[uri]

    def resolve(self, props: dict, curie: str) -> list[tuple[str, bool]]:
        """Concept references as (iri, uncertain). The source writes uncertain values as a
        nested record: [ rdf:value nm:rome ; un:hasUncertainty nm:uncertain_value ]."""
        out = []
        for v in props.get(iri(curie), []):
            if isinstance(v, ox.NamedNode):
                out.append((v.value, False))
            elif isinstance(v, ox.BlankNode):
                bp = self.g.props(v)
                uncertain = bool(nodes(bp, "un:hasUncertainty"))
                out += [(ref, uncertain) for ref in refs(bp, "rdf:value")]
            else:
                self.warnings[f"{curie} given as text, not a Nomisma ID"] += 1
        return out

    def classes(self, uri: str) -> set[str]:
        return {n.value for n in nodes(self.concept(uri), "rdf:type")}

    def insert(self, table: str, row: dict) -> None:
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        self.db.execute(f"INSERT OR IGNORE INTO {table} ({cols}) VALUES ({marks})", list(row.values()))

    def add_external_ids(self, entity_type: str, entity_id: str, props: dict) -> None:
        for curie, match in (("skos:exactMatch", "exact"), ("skos:closeMatch", "close")):
            for uri in all_values(props, curie):
                self.insert("external_id", {
                    "entity_type": entity_type, "entity_id": entity_id,
                    "system": external_system(uri), "uri": uri,
                    "match_type": match, "method": "source"})

    # -- reference entities --------------------------------------------------

    def ensure_person(self, uri: str) -> str | None:
        pid = local_id(uri)
        if pid in self._inserted["person"]:
            return pid
        p = self.concept(uri)
        if not p:
            self.warnings["person missing from Nomisma"] += 1
            return None
        starts, ends = [], []
        for m in nodes(p, "org:hasMembership"):
            mp = self.g.props(m)
            starts += [parse_year(v) for v in all_values(mp, "nmo:hasStartDate")]
            ends += [parse_year(v) for v in all_values(mp, "nmo:hasEndDate")]
        starts = [y for y in starts if y is not None]
        ends = [y for y in ends if y is not None]

        def life_year(curie: str) -> int | None:
            for n in nodes(p, curie):
                return parse_year(first(self.g.props(n), "dcterms:date"))
            return None

        self.insert("person", {
            "id": pid, "nomisma_uri": uri, "name": label(p) or pid,
            "definition": label(p, "skos:definition"),
            "start_year": min(starts) if starts else None,
            "end_year": max(ends) if ends else None,
            "birth_year": life_year("bio:birth"), "death_year": life_year("bio:death")})
        self.add_external_ids("person", pid, p)
        self._inserted["person"].add(pid)
        return pid

    def ensure_simple(self, table: str, uri: str, extra: dict | None = None) -> str | None:
        cid = local_id(uri)
        if cid in self._inserted[table]:
            return cid
        p = self.concept(uri)
        if not p:
            self.warnings[f"{table} missing from Nomisma"] += 1
            return None
        row = {"id": cid, "nomisma_uri": uri, "name": label(p) or cid}
        if table != "material":
            row["definition"] = label(p, "skos:definition")
        row.update(extra(p) if callable(extra) else (extra or {}))
        self.insert(table, row)
        if table in ("mint", "denomination", "subject"):
            self.add_external_ids(table, cid, p)
        self._inserted[table].add(cid)
        return cid

    def _mint_coords(self, p: dict) -> dict:
        for loc in nodes(p, "geo:location"):
            lp = self.g.props(loc)
            lat, lon = first(lp, "geo:lat"), first(lp, "geo:long")
            if lat and lon:
                return {"lat": float(lat), "lon": float(lon)}
        return {"lat": None, "lon": None}

    def ensure_subject(self, uri: str) -> str | None:
        kind = "deity" if DEITY in self.classes(uri) else "other"
        return self.ensure_simple("subject", uri, {"kind": kind})

    # -- datasets ------------------------------------------------------------

    def build_datasets(self) -> None:
        rules = self.config["licence_rules"]
        overrides = self.config.get("image_overrides", {})
        for uri in self.g.subjects_of_type("void:Dataset"):
            p = self.g.props(uri)
            licence = first(p, "dcterms:license") or first(p, "dcterms:rights")
            ok = commercial_ok(licence, rules)
            override = overrides.get(uri, {})
            self.insert("dataset", {
                "id": uri, "name": label(p, "dcterms:title"), "data_licence": licence,
                "image_licence": override.get("image_licence"),
                "commercial_ok": int(override.get("commercial_ok", ok))})
            self._inserted["dataset"].add(uri)

    # -- types ---------------------------------------------------------------

    def build_types(self, corpus_key: str, corpus: dict) -> dict[str, str]:
        """Returns normalised source URI -> type id, for linking specimens.

        A retired type with exactly one replacement maps to that replacement, so
        specimens follow it. A type split into several stays as it is: which of the
        new types a specimen belongs to is ambiguous.
        """
        index: dict[str, str] = {}
        replacements: dict[str, list[str]] = {}
        type_uris = [u for u in self.g.subjects_of_type("nmo:TypeSeriesItem")
                     if corpus["dataset"] in all_values(self.g.props(u), "void:inDataset")]
        rows, people, orgs, subjects, denoms, mats = [], [], [], [], [], []
        for uri in type_uris:
            p = self.g.props(uri)
            tid = local_id(uri)
            title = label(p)
            volume, number = parse_ric_label(title)
            mints = self.resolve(p, "nmo:hasMint")
            mint_uri, uncertain = mints[0] if mints else (None, False)
            if mint_uri == UNCERTAIN:
                mint_uri, uncertain = None, True
            mint_id = self.ensure_simple("mint", mint_uri, self._mint_coords) if mint_uri else None
            broader = [b for b in all_values(p, "skos:broader") if corpus["id_path"] in b]
            replaced = all_values(p, "dcterms:isReplacedBy")

            sides = {}
            for side in ("obverse", "reverse"):
                side_nodes = nodes(p, f"nmo:has{side.capitalize()}")
                sp = self.g.props(side_nodes[0]) if side_nodes else {}
                sides[side] = sp
                for portrait, _ in self.resolve(sp, "nmo:hasPortrait"):
                    if PERSON in self.classes(portrait):
                        if pid := self.ensure_person(portrait):
                            people.append((tid, pid, f"portrait_{side}"))
                    elif sid := self.ensure_subject(portrait):
                        subjects.append((tid, sid, side))

            for curie, role in (("nmo:hasAuthority", "authority"), ("nmo:hasIssuer", "issuer")):
                for ref, _ in self.resolve(p, curie):
                    classes = self.classes(ref)
                    if PERSON in classes:
                        if pid := self.ensure_person(ref):
                            people.append((tid, pid, role))
                    elif ORGANIZATION in classes:
                        if oid := self.ensure_simple("organization", ref):
                            orgs.append((tid, oid, role))
                    else:
                        self.warnings[f"{role} that is neither a person nor an organization"] += 1
            for d, _ in self.resolve(p, "nmo:hasDenomination"):
                if did := self.ensure_simple("denomination", d):
                    denoms.append((tid, did))
            for m, _ in self.resolve(p, "nmo:hasMaterial"):
                if mid := self.ensure_simple("material", m):
                    mats.append((tid, mid))

            rows.append({
                "id": tid, "source_uri": uri, "corpus": corpus_key, "title": title,
                "ric_volume": volume, "ric_number": number,
                "parent_id": local_id(broader[0]) if broader else None,
                "replaced_by_id": local_id(replaced[0]) if replaced else None,
                "start_year": parse_year(first(p, "nmo:hasStartDate")),
                "end_year": parse_year(first(p, "nmo:hasEndDate")),
                "mint_id": mint_id, "mint_uncertain": int(uncertain),
                "obv_legend": first(sides["obverse"], "nmo:hasLegend"),
                "obv_description": label(sides["obverse"], "dcterms:description"),
                "rev_legend": first(sides["reverse"], "nmo:hasLegend"),
                "rev_description": label(sides["reverse"], "dcterms:description")})
            index[normalise_uri(uri)] = tid
            replacements[tid] = [local_id(u) for u in replaced]

        # Parents may sit outside a partial build; only keep in-scope references.
        ids = {r["id"] for r in rows}
        for r in rows:
            if r["parent_id"] not in ids:
                r["parent_id"] = None
        # Insert without parents first, then link them, so order doesn't matter.
        for r in rows:
            self.insert("coin_type", {**r, "parent_id": None})
        self.db.executemany("UPDATE coin_type SET parent_id = ? WHERE id = ?",
                            [(r["parent_id"], r["id"]) for r in rows if r["parent_id"]])
        for tid, pid, role in people:
            self.insert("type_person", {"type_id": tid, "person_id": pid, "role": role})
        for tid, oid, role in orgs:
            self.insert("type_organization", {"type_id": tid, "organization_id": oid, "role": role})
        for tid, sid, side in subjects:
            self.insert("type_subject", {"type_id": tid, "subject_id": sid, "side": side,
                                         "method": "source", "confidence": 1.0})
        for tid, did in denoms:
            self.insert("type_denomination", {"type_id": tid, "denomination_id": did})
        for tid, mid in mats:
            self.insert("type_material", {"type_id": tid, "material_id": mid})
        self.redirects = {tid: new[0] for tid, new in replacements.items()
                          if len(new) == 1 and new[0] in ids}
        self.log(f"  types: {len(rows)} ({len(self.redirects)} retired types redirect to a single replacement)")
        return index

    # -- specimens -----------------------------------------------------------

    def _image_rows(self, specimen_id: str, p: dict) -> list[dict]:
        out = []

        def add(side: str, holder: dict) -> None:
            thumbs = all_values(holder, "foaf:thumbnail")
            for img in nodes(holder, "foaf:depiction"):
                if not plausible_url(img.value):
                    self.warnings["placeholder image URL dropped"] += 1
                    continue
                ip = self.g.props(img)
                iiif = first(ip, "svcs:has_service") or first(ip, "svcs:hasService")
                out.append({"specimen_id": specimen_id, "side": side, "url": img.value,
                            "thumbnail_url": thumbs[0] if thumbs else None,
                            "iiif_service": iiif})

        for side in ("obverse", "reverse"):
            for n in nodes(p, f"nmo:has{side.capitalize()}"):
                add(side, self.g.props(n))
        add("combined", p)
        return out

    def build_specimens(self, type_index: dict[str, str]) -> None:
        n_specimens = n_links = n_images = 0
        for uri in self.g.subjects_of_type("nmo:NumismaticObject"):
            p = self.g.props(uri)
            links = []
            for t in all_values(p, "nmo:hasTypeSeriesItem"):
                tid = type_index.get(normalise_uri(t))
                if not tid:
                    continue
                method = "source" if normalise_uri(t) == t.rstrip("/") else "normalised_uri"
                if tid in self.redirects:
                    tid, method = self.redirects[tid], "redirected"
                links.append((tid, method))
            if not links:
                continue
            sid = short_hash(uri)
            dataset = first(p, "void:inDataset")
            if dataset and dataset not in self._inserted["dataset"]:
                self.insert("dataset", {"id": dataset, "commercial_ok": 0})
                self._inserted["dataset"].add(dataset)
                self.warnings["dataset without metadata"] += 1
            inst = (refs(p, "nmo:hasCollection") or [None])[0]
            inst_id = None
            if inst:
                inst_id = local_id(inst)
                if inst_id not in self._inserted["institution"]:
                    ip = self.concept(inst)
                    self.insert("institution", {"id": inst_id, "nomisma_uri": inst,
                                                "name": label(ip) or inst_id})
                    self._inserted["institution"].add(inst_id)

            def num(curie: str) -> float | None:
                v = first(p, curie)
                try:
                    return float(v) if v is not None else None
                except ValueError:
                    self.warnings[f"bad number {curie}"] += 1
                    return None

            axis = num("nmo:hasAxis")
            self.insert("specimen", {
                "id": sid, "source_uri": uri, "dataset_id": dataset, "institution_id": inst_id,
                "identifier": first(p, "dcterms:identifier"), "title": label(p, "dcterms:title"),
                "weight_g": plausible_weight(num("nmo:hasWeight")), "diameter_mm": num("nmo:hasDiameter"),
                "die_axis": int(axis) if axis is not None else None})
            n_specimens += 1
            for tid, method in dict(links).items():
                self.insert("specimen_type", {"specimen_id": sid, "type_id": tid, "link_method": method})
                n_links += 1
            for img in self._image_rows(sid, p):
                self.insert("image", img)
                n_images += 1
        self.log(f"  specimens: {n_specimens} ({n_links} type links, {n_images} images)")

    def finish(self, info: dict) -> None:
        info = {**info, "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        for k, v in info.items():
            self.insert("build_info", {"key": k, "value": str(v)})
        for k, v in self.warnings.items():
            self.insert("build_info", {"key": f"warning: {k}", "value": str(v)})
        self.db.commit()


def build(graph: Graph, db_path: Path, config: dict, info: dict, log=print) -> Builder:
    b = Builder(graph, db_path, config, log)
    b.build_datasets()
    index: dict[str, str] = {}
    for key, corpus in config["corpora"].items():
        index |= b.build_types(key, corpus)
    b.build_specimens(index)
    b.finish(info)
    return b
