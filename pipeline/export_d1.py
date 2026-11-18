"""`solidi export-d1`: write the built SQLite as SQL that Cloudflare D1 can load.

D1 loads SQL statements, not .sqlite files. The output has the same schema and rows, with three
differences D1 needs:
- no transaction or PRAGMA lines from a plain `.dump` (D1 wraps the load itself);
- FTS5 search indexes are not copied as data (their shadow tables can't be loaded); the empty
  virtual tables are created and filled with FTS5's 'rebuild' command at the end;
- rows go out as multi-row INSERTs kept under D1's 100 KB statement limit.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

# D1 rejects statements over 100 KB; stay well under it.
MAX_STATEMENT_BYTES = 90_000
FTS_SHADOW_SUFFIXES = ("_data", "_idx", "_docsize", "_config", "_content")


def _objects(db: sqlite3.Connection) -> tuple[list[tuple[str, str]], list[str], list[tuple[str, str]]]:
    """Tables (name, sql), explicit index SQL, and FTS virtual tables (name, sql), in creation order."""
    rows = db.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
    ).fetchall()
    virtual = [(name, sql) for kind, name, sql in rows if kind == "table" and sql.upper().startswith("CREATE VIRTUAL")]
    shadows = {v + s for v, _ in virtual for s in FTS_SHADOW_SUFFIXES}
    tables = [(name, sql) for kind, name, sql in rows
              if kind == "table" and name not in shadows and (name, sql) not in virtual]
    indexes = [sql for kind, _, sql in rows if kind == "index"]
    return tables, indexes, virtual


def _inserts(db: sqlite3.Connection, table: str) -> list[str]:
    cols = [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
    quoted = " || ',' || ".join(f'quote("{c}")' for c in cols)
    head = f'INSERT INTO "{table}" ({", ".join(chr(34) + c + chr(34) for c in cols)}) VALUES '
    statements, batch, size = [], [], len(head)
    if "parent_id" in cols:
        # Self-referencing trees (types, regions, categories): parents before children, at any depth.
        query = f"""WITH RECURSIVE depth(id, d) AS (
                        SELECT id, 0 FROM "{table}" WHERE parent_id IS NULL
                        UNION ALL SELECT c.id, depth.d + 1 FROM "{table}" c JOIN depth ON c.parent_id = depth.id)
                    SELECT {quoted} FROM "{table}" JOIN depth USING (id) ORDER BY depth.d, "{table}".rowid"""
    else:
        query = f'SELECT {quoted} FROM "{table}" ORDER BY rowid'
    for (values,) in db.execute(query):
        row = f"({values})"
        if batch and size + len(row) + 1 > MAX_STATEMENT_BYTES:
            statements.append(head + ",".join(batch) + ";")
            batch, size = [], len(head)
        batch.append(row)
        size += len(row) + 1
    if batch:
        statements.append(head + ",".join(batch) + ";")
    return statements


def export(db_path: Path, out_path: Path) -> dict[str, int]:
    db = sqlite3.connect(db_path)
    tables, indexes, virtual = _objects(db)
    counts: dict[str, int] = {}
    with out_path.open("w", encoding="utf-8") as out:
        # Search tables first, then children before parents, so reloading never trips a foreign key.
        for name, _ in virtual:
            out.write(f'DROP TABLE IF EXISTS "{name}";\n')
        for name, _ in reversed(tables):
            out.write(f'DROP TABLE IF EXISTS "{name}";\n')
        for _, sql in tables:
            out.write(sql + ";\n")
        for name, _ in tables:
            for statement in _inserts(db, name):
                out.write(statement + "\n")
            counts[name] = db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
        for sql in indexes:
            out.write(sql + ";\n")
        for name, sql in virtual:
            out.write(sql + ";\n")
            out.write(f"INSERT INTO \"{name}\" (\"{name}\") VALUES ('rebuild');\n")
    db.close()
    return counts
