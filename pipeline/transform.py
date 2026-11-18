"""Link and build: turn the staged RDF graph into the canonical SQLite database."""

from __future__ import annotations

import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pyoxigraph as ox

from pipeline.stage import Graph, all_values, first, iri, label, nodes, refs
from pipeline.util import (
    commercial_ok, entity_id, external_system, is_nomisma, normalise_uri, parse_reference,
    parse_year, plausible_url, plausible_weight, reference_sort_key, short_hash,
)

SCHEMA = Path(__file__).with_name("schema.sql")
UNCERTAIN = "http://nomisma.org/id/uncertain_value"

PERSON = iri("foaf:Person")
ORGANIZATION = iri("foaf:Organization")
DEITY = iri("wordnet:Deity")
REGION = iri("nmo:Region")


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
                                                ("person", "organization", "mint", "region", "denomination",
                                                 "material", "subject", "symbol", "reference_work",
                                                 "institution", "dataset")}
        # Dataset slug by the URI path its records live under ('/ocre/id/' -> 'ocre').
        self.id_paths = {c["id_path"]: key for key, c in config["corpora"].items()}

    # -- IDs -----------------------------------------------------------------

    def source_of(self, uri: str) -> str:
        """Registry a URI belongs to: 'nomisma', a dataset slug, or the host."""
        if is_nomisma(uri):
            return "nomisma"
        for key, c in self.config["corpora"].items():
            if normalise_uri(uri).startswith(normalise_uri(c["dataset"]) + "/"):
                return key
        host = uri.split("://", 1)[-1].split("/", 1)[0]
        return host.removeprefix("www.").replace(".", "-")

    def eid(self, uri: str) -> str:
        return entity_id(uri, self.source_of(uri))

    def type_id(self, uri: str) -> str | None:
        """'http://numismatics.org/ocre/id/ric.2.tr.147' -> 'ocre/ric.2.tr.147'."""
        for path, slug in self.id_paths.items():
            if path in uri:
                return f"{slug}/{uri.split(path, 1)[1].split('#', 1)[0]}"
        return None

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
        pid = self.eid(uri)
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
            "id": pid, "uri": uri, "source": self.source_of(uri), "name": label(p) or pid,
            "definition": label(p, "skos:definition"),
            "start_year": min(starts) if starts else None,
            "end_year": max(ends) if ends else None,
            "birth_year": life_year("bio:birth"), "death_year": life_year("bio:death")})
        self.add_external_ids("person", pid, p)
        self._inserted["person"].add(pid)
        return pid

    def ensure_simple(self, table: str, uri: str, extra=None) -> str | None:
        cid = self.eid(uri)
        if cid in self._inserted[table]:
            return cid
        p = self.concept(uri)
        if not p:
            self.warnings[f"{table} missing from its source"] += 1
            return None
        self._inserted[table].add(cid)      # before extra(): a region's parent chain may loop back
        row = {"id": cid, "uri": uri, "source": self.source_of(uri), "name": label(p) or cid}
        if table not in ("material", "reference_work"):
            row["definition"] = label(p, "skos:definition")
        row.update(extra(p) if callable(extra) else (extra or {}))
        self.insert(table, row)
        if table in ("mint", "region", "denomination", "subject"):
            self.add_external_ids(table, cid, p)
        return cid

    def _coords(self, p: dict) -> dict:
        for loc in nodes(p, "geo:location"):
            lp = self.g.props(loc)
            lat, lon = first(lp, "geo:lat"), first(lp, "geo:long")
            if lat and lon:
                return {"lat": float(lat), "lon": float(lon)}
        return {"lat": None, "lon": None}

    def _parent_region(self, p: dict) -> str | None:
        """The first broader concept that is a region, inserted first so the foreign key holds."""
        for b in refs(p, "skos:broader"):
            if REGION in self.classes(b):
                return self.ensure_region(b)
        return None

    def ensure_region(self, uri: str) -> str | None:
        return self.ensure_simple("region", uri,
                                  lambda p: {**self._coords(p), "parent_id": self._parent_region(p)})

    def ensure_mint(self, uri: str) -> str | None:
        return self.ensure_simple("mint", uri,
                                  lambda p: {**self._coords(p), "region_id": self._parent_region(p)})

    def ensure_symbol(self, uri: str) -> str | None:
        """Monograms and control marks. Numishare describes them with CIDOC-CRM: the drawing via
        P165i_is_incorporated_in, the letters via P106_is_composed_of."""
        crm = "http://www.cidoc-crm.org/cidoc-crm/"
        sid = self.eid(uri)
        if sid not in self._inserted["symbol"] and not self.concept(uri):
            # Cited by types but never published (OCRE's officina marks): keep the link.
            self.warnings["symbol cited but not published by its source"] += 1
            self.insert("symbol", {"id": sid, "uri": uri, "source": self.source_of(uri),
                                   "name": uri.rsplit("/", 1)[-1], "published": 0})
            self._inserted["symbol"].add(sid)
            return sid

        def extra(p: dict) -> dict:
            image = next((v.value for v in p.get(crm + "P165i_is_incorporated_in", [])
                          if isinstance(v, ox.NamedNode)), None)
            letters = [v.value for v in p.get(crm + "P106_is_composed_of", []) if isinstance(v, ox.Literal)]
            return {"image_url": image, "letters": " ".join(sorted(letters)) or None, "published": 1}
        return self.ensure_simple("symbol", uri, extra)

    def ensure_subject(self, uri: str) -> str | None:
        kind = "deity" if DEITY in self.classes(uri) else "other"
        return self.ensure_simple("subject", uri, {"kind": kind})

    # -- datasets ------------------------------------------------------------

    def build_datasets(self) -> None:
        rules = self.config["licence_rules"]
        overrides = {normalise_uri(k): v for k, v in self.config.get("image_overrides", {}).items()}
        slugs = {normalise_uri(c["dataset"]): key for key, c in self.config["corpora"].items()}
        for uri in self.g.subjects_of_type("void:Dataset"):
            p = self.g.props(uri)
            licence = first(p, "dcterms:license") or first(p, "dcterms:rights")
            ok = commercial_ok(licence, rules)
            override = overrides.get(normalise_uri(uri), {})
            self.insert("dataset", {
                "id": uri, "slug": slugs.get(normalise_uri(uri)),
                "name": label(p, "dcterms:title"), "data_licence": licence,
                "image_licence": override.get("image_licence"),
                "commercial_ok": int(override.get("commercial_ok", ok))})
            self._inserted["dataset"].add(uri)
        for key, c in self.config["corpora"].items():
            if not self.db.execute("SELECT 1 FROM dataset WHERE slug = ?", (key,)).fetchone():
                raise ValueError(f"no Nomisma metadata for dataset {c['dataset']} ({key})")

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
        dataset_id = self.db.execute("SELECT id FROM dataset WHERE slug = ?", (corpus_key,)).fetchone()[0]
        rows, people, orgs, subjects, denoms, mats = [], [], [], [], [], []
        references, matches, regions, symbols = [], [], [], []
        for uri in type_uris:
            p = self.g.props(uri)
            tid = self.type_id(uri)
            title = label(p)
            mints = self.resolve(p, "nmo:hasMint")
            mint_uri, uncertain = mints[0] if mints else (None, False)
            if mint_uri == UNCERTAIN:
                mint_uri, uncertain = None, True
            mint_id = self.ensure_mint(mint_uri) if mint_uri else None
            broader = [b for b in all_values(p, "skos:broader") if corpus["id_path"] in b]
            replaced = all_values(p, "dcterms:isReplacedBy")

            for i, work_uri in enumerate(refs(p, "dcterms:source")):
                if wid := self.ensure_simple("reference_work", work_uri):
                    volume, number = parse_reference(wid, title)
                    references.append({"type_id": tid, "work_id": wid, "label": title or tid,
                                       "volume": volume, "number": number,
                                       "sort_key": reference_sort_key(volume, number),
                                       "is_primary": int(i == 0)})
            if not refs(p, "dcterms:source"):
                self.warnings["type without a reference work"] += 1
            for m in refs(p, "skos:exactMatch"):
                matches.append((tid, m))
            for r, _ in self.resolve(p, "nmo:hasRegion"):
                if r != UNCERTAIN and (rid := self.ensure_region(r)):
                    regions.append((tid, rid))

            sides = {}
            for side in ("obverse", "reverse"):
                side_nodes = nodes(p, f"nmo:has{side.capitalize()}")
                sp = self.g.props(side_nodes[0]) if side_nodes else {}
                sides[side] = sp
                for mark, unsure in self.resolve(sp, "nmo:hasControlmark"):
                    if sym := self.ensure_symbol(mark):
                        symbols.append((tid, side, sym, unsure))
                for portrait, _ in self.resolve(sp, "nmo:hasPortrait"):
                    if PERSON in self.classes(portrait):
                        if pid := self.ensure_person(portrait):
                            people.append((tid, pid, f"portrait_{side}"))
                    elif sid := self.ensure_subject(portrait):
                        subjects.append((tid, sid, side))

            for curie, role in (("nmo:hasAuthority", "authority"), ("nmo:hasStatedAuthority", "stated_authority"),
                                ("nmo:hasIssuer", "issuer")):
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
                "id": tid, "source_uri": uri, "dataset_id": dataset_id, "title": title,
                "parent_id": self.type_id(broader[0]) if broader else None,
                "replaced_by_id": (self.type_id(replaced[0]) or replaced[0]) if replaced else None,
                "start_year": parse_year(first(p, "nmo:hasStartDate")),
                "end_year": parse_year(first(p, "nmo:hasEndDate")),
                "mint_id": mint_id, "mint_uncertain": int(uncertain),
                "obv_legend": first(sides["obverse"], "nmo:hasLegend"),
                "obv_description": label(sides["obverse"], "dcterms:description"),
                "rev_legend": first(sides["reverse"], "nmo:hasLegend"),
                "rev_description": label(sides["reverse"], "dcterms:description")})
            index[normalise_uri(uri)] = tid
            replacements[tid] = [self.type_id(u) or u for u in replaced]

        # Parents may sit outside a partial build; only keep in-scope references.
        ids = {r["id"] for r in rows}
        for r in rows:
            if r["parent_id"] == r["id"]:
                self.warnings["type listed as its own parent"] += 1
            if r["parent_id"] not in ids or r["parent_id"] == r["id"]:
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
        for ref in references:
            self.insert("type_reference", ref)
        for tid, rid in regions:
            self.insert("type_region", {"type_id": tid, "region_id": rid})
        for tid, side, sym, unsure in symbols:
            self.insert("type_symbol", {"type_id": tid, "side": side, "symbol_id": sym, "uncertain": int(unsure)})
        # Matches resolve against every corpus built so far; link_matches() finishes the rest.
        for tid, m in matches:
            self.insert("type_match", {"type_id": tid, "uri": m, "relation": "exact"})
        def final(tid: str, seen: set[str]) -> str | None:
            new = replacements.get(tid, [])
            if not new:
                return tid
            if len(new) > 1 or new[0] in seen or new[0] not in ids:
                return None          # split, cycle or outside the build: stay put
            return final(new[0], seen | {tid})

        self.redirects = {}
        for tid, new in replacements.items():
            if new and (target := final(tid, set())) and target != tid:
                self.redirects[tid] = target
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
            if inst and not plausible_url(inst):
                self.warnings["placeholder collection URI dropped"] += 1
                inst = None
            inst_id = None
            if inst:
                inst_id = self.eid(inst)
                if inst_id not in self._inserted["institution"]:
                    ip = self.concept(inst)
                    self.insert("institution", {"id": inst_id, "uri": inst, "source": self.source_of(inst),
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

    def link_matches(self, index: dict[str, str]) -> None:
        """Point type matches at types in the build, once every corpus is in."""
        rows = self.db.execute("SELECT type_id, uri FROM type_match").fetchall()
        targets = [(index[normalise_uri(u)], t, u) for t, u in rows if normalise_uri(u) in index]
        self.db.executemany("UPDATE type_match SET target_type_id = ? WHERE type_id = ? AND uri = ?", targets)
        self.log(f"  type matches: {len(rows)} ({len(targets)} to types in the build)")

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
    b.link_matches(index)
    b.build_specimens(index)
    b.finish(info)
    return b
