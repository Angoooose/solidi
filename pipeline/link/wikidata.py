"""Enrich the built database from Wikidata: fill missing Wikidata links, life dates and family."""

from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from pathlib import Path

from pipeline.sources.wikidata import fetch

ENTITY_TABLES = ("person", "organization", "mint", "denomination", "subject")
RELATIONS = {"father": "father", "mother": "mother", "spouse": "spouse", "child": "child"}


def qid(uri: str) -> str | None:
    m = re.search(r"wikidata\.org/(?:entity|wiki)/(Q\d+)", uri or "")
    return m.group(1) if m else None


def wikidata_year(value: str | None) -> int | None:
    """WDQS returns astronomical years: '-0062-09-21T…' is 63 BC (there is a year 0).
    Convert to historical numbering, as Nomisma uses: 1 BC = -1, no year 0."""
    if not value:
        return None
    m = re.match(r"^(-?)(\d+)-", value)
    if not m:
        return None
    year = int(m.group(2))
    if m.group(1):
        return -(year + 1)
    return year if year > 0 else -1


def enrich(db: sqlite3.Connection, raw_dir: Path, refresh: bool = False, log=print) -> dict:
    stats: dict[str, int] = defaultdict(int)

    # 1. Wikidata's own reverse links (P2950 = Nomisma ID) fill gaps in Nomisma's links.
    rows = fetch.by_nomisma(raw_dir, refresh)
    by_nm: dict[str, str] = {}
    for r in rows:
        if q := qid(r["item"]):
            by_nm.setdefault(r["nm"], q)
    for table in ENTITY_TABLES:
        missing = [i for (i,) in db.execute(f"""
            SELECT id FROM {table} WHERE id NOT IN
              (SELECT entity_id FROM external_id WHERE entity_type = ? AND system = 'wikidata')""", (table,))]
        for entity_id in missing:
            if q := by_nm.get(entity_id):
                db.execute("""INSERT OR IGNORE INTO external_id
                              (entity_type, entity_id, system, uri, match_type, method)
                              VALUES (?, ?, 'wikidata', ?, 'exact', 'wikidata_p2950')""",
                           (table, entity_id, f"http://www.wikidata.org/entity/{q}"))
                stats[f"{table} wikidata links added"] += 1

    # 2. One QID per entity: exact matches first.
    entity_qid: dict[tuple[str, str], str] = {}
    for etype, eid, uri, match in db.execute("""
            SELECT entity_type, entity_id, uri, match_type FROM external_id
            WHERE system = 'wikidata' ORDER BY match_type = 'exact' DESC, uri"""):
        if (q := qid(uri)) and (etype, eid) not in entity_qid:
            entity_qid[(etype, eid)] = q

    # 3. Facts for every QID we hold.
    facts: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        facts[qid(r["item"])].append(r)
    unknown = [q for q in entity_qid.values() if q not in facts]
    for r in fetch.by_qids(raw_dir, unknown, refresh):
        facts[qid(r["item"])].append(r)

    # 4. Life dates where Nomisma has none.
    person_by_qid = {q: eid for (etype, eid), q in entity_qid.items() if etype == "person"}
    for q, pid in person_by_qid.items():
        f = facts.get(q, [])
        births = [y for r in f if (y := wikidata_year(r.get("birth")))]
        deaths = [y for r in f if (y := wikidata_year(r.get("death")))]
        if births:
            n = db.execute("UPDATE person SET birth_year = ? WHERE id = ? AND birth_year IS NULL",
                           (min(births), pid)).rowcount
            stats["birth years added"] += n
        if deaths:
            n = db.execute("UPDATE person SET death_year = ? WHERE id = ? AND death_year IS NULL",
                           (min(deaths), pid)).rowcount
            stats["death years added"] += n

    # 5. Family relations between people we hold.
    for q, pid in person_by_qid.items():
        for r in facts.get(q, []):
            for field, relation in RELATIONS.items():
                other = person_by_qid.get(qid(r.get(field)))
                if other and other != pid:
                    stats["relations"] += db.execute(
                        """INSERT OR IGNORE INTO person_relation (person_id, relation, related_person_id)
                           VALUES (?, ?, ?)""", (pid, relation, other)).rowcount

    # 6. English Wikipedia article per entity, for the article step.
    for (etype, eid), q in entity_qid.items():
        urls = sorted({r["article"] for r in facts.get(q, []) if r.get("article")})
        if urls:
            db.execute("""INSERT OR IGNORE INTO wikipedia_link (entity_type, entity_id, qid, url)
                          VALUES (?, ?, ?, ?)""", (etype, eid, q, urls[0]))
            stats["wikipedia links"] += 1

    db.commit()
    for k, v in sorted(stats.items()):
        log(f"  {k}: {v}")
    return dict(stats)
