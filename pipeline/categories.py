"""Place every coin type in a collector category, using the tree and rules in data/categories.yaml."""

from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict
from pathlib import Path


def _insert_tree(db: sqlite3.Connection, nodes: list[dict], parent: str | None, seen: set[str]) -> None:
    for order, node in enumerate(nodes):
        if node["id"] in seen:
            raise ValueError(f"category {node['id']!r} defined twice")
        seen.add(node["id"])
        db.execute("INSERT INTO category (id, parent_id, name, description, sort_order) VALUES (?, ?, ?, ?, ?)",
                   (node["id"], parent, node["name"], node.get("description"), order))
        _insert_tree(db, node.get("children") or [], node["id"], seen)


def _matches(rule: dict, t: dict) -> bool:
    if "dataset" in rule and t["dataset"] != rule["dataset"]:
        return False
    if "work" in rule and rule["work"] not in t["works"]:
        return False
    if "authorities" in rule and not set(rule["authorities"]) & t["authorities"]:
        return False
    if "from_year" in rule and (t["start"] is None or t["start"] < rule["from_year"]):
        return False
    if "to_year" in rule and (t["end"] is None or t["end"] > rule["to_year"]):
        return False
    if "to_start_year" in rule and (t["start"] is None or t["start"] > rule["to_start_year"]):
        return False
    return True


def assign(db: sqlite3.Connection, config: dict, log=print) -> Counter:
    seen: set[str] = set()
    _insert_tree(db, config.get("categories") or [], None, seen)
    rules = config.get("rules") or []
    for rule in rules:
        if rule["category"] not in seen:
            raise ValueError(f"rule names unknown category {rule['category']!r}")

    authorities: dict[str, set[str]] = defaultdict(set)
    for tid, aid in db.execute("""SELECT type_id, person_id FROM type_person WHERE role = 'authority'
                                  UNION SELECT type_id, organization_id FROM type_organization
                                  WHERE role = 'authority'"""):
        authorities[tid].add(aid)
    works: dict[str, set[str]] = defaultdict(set)
    for tid, wid in db.execute("SELECT type_id, work_id FROM type_reference"):
        works[tid].add(wid)

    counts: Counter = Counter()
    rows = []
    for tid, slug, start, end in db.execute("""SELECT t.id, d.slug, t.start_year, t.end_year
                                               FROM coin_type t JOIN dataset d ON d.id = t.dataset_id"""):
        t = {"dataset": slug, "start": start, "end": end,
             "authorities": authorities[tid], "works": works[tid]}
        rule = next((r for r in rules if _matches(r, t)), None)
        if rule:
            rows.append((tid, rule["category"]))
        counts[rule["category"] if rule else None] += 1
    db.executemany("""INSERT INTO type_category (type_id, category_id, is_primary, method)
                      VALUES (?, ?, 1, 'rule')""", rows)
    db.commit()
    for cat, n in counts.most_common():
        log(f"  {cat or 'uncategorised'}: {n}")
    return counts


def load_and_assign(db: sqlite3.Connection, path: Path, log=print) -> Counter:
    import yaml
    return assign(db, yaml.safe_load(path.read_text(encoding="utf-8")) or {}, log)
