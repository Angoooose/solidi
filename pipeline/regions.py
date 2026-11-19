"""Group regions under catalogue headings and tidy mint regions, from data/regions.yaml."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def _merge(db: sqlite3.Connection, old: str, new: str) -> None:
    """Fold region `old` into `new`: its mints, types and child regions move across, then it goes."""
    db.execute("UPDATE mint SET region_id = ? WHERE region_id = ?", (new, old))
    db.execute("UPDATE region SET parent_id = ? WHERE parent_id = ?", (new, old))
    db.execute("UPDATE OR IGNORE type_region SET region_id = ? WHERE region_id = ?", (new, old))
    db.execute("DELETE FROM type_region WHERE region_id = ?", (old,))
    for table in ("external_id", "wikipedia_link", "article"):
        db.execute(f"DELETE FROM {table} WHERE entity_type = 'region' AND entity_id = ?", (old,))
    db.execute("DELETE FROM region WHERE id = ?", (old,))


def apply(db: sqlite3.Connection, config: dict, log=print) -> list[str]:
    """Returns warnings: listed regions that don't exist, and used regions with no heading."""
    warnings = []
    exists = lambda table, id: db.execute(f"SELECT 1 FROM {table} WHERE id = ?", (id,)).fetchone()

    for old, new in (config.get("merge") or {}).items():
        if exists("region", old) and exists("region", new):
            _merge(db, old, new)
        else:
            warnings.append(f"regions.yaml merge {old} -> {new}: region missing")

    for mint, region in (config.get("mints") or {}).items():
        if not exists("mint", mint) or not exists("region", region):
            warnings.append(f"regions.yaml mint {mint} -> {region}: mint or region missing")
            continue
        db.execute("UPDATE mint SET region_id = ? WHERE id = ?", (region, mint))

    seen: set[str] = set()
    for g_order, group in enumerate(config.get("groups") or []):
        db.execute("INSERT INTO region_group (id, name, sort_order) VALUES (?, ?, ?)",
                   (group["id"], group["name"], g_order))
        for r_order, region in enumerate(group["regions"]):
            if region in seen:
                raise ValueError(f"regions.yaml: {region!r} is under two headings")
            seen.add(region)
            if not exists("region", region):
                warnings.append(f"regions.yaml lists unknown region {region!r}")
                continue
            db.execute("UPDATE region SET group_id = ?, sort_order = ? WHERE id = ?",
                       (group["id"], r_order, region))

    # Regions a live type's mint sits in (workshops take their city's region) but no heading lists.
    for (region, n) in db.execute("""
            SELECT r.id, count(*) FROM coin_type t
            JOIN mint m ON m.id = t.mint_id
            LEFT JOIN mint p ON p.id = m.parent_id
            JOIN region r ON r.id = coalesce(m.region_id, p.region_id)
            WHERE t.replaced_by_id IS NULL AND r.group_id IS NULL
            GROUP BY r.id ORDER BY 2 DESC"""):
        warnings.append(f"region {region} ({n} types) has no heading in regions.yaml")
    db.commit()
    for w in warnings:
        log(f"  warning: {w}")
    return warnings


def load_and_apply(db: sqlite3.Connection, path: Path, log=print) -> list[str]:
    import yaml
    return apply(db, yaml.safe_load(path.read_text(encoding="utf-8")) or {}, log)
