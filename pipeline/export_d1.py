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
    # D1's limit is in bytes: Greek is 2 bytes a letter in UTF-8, Kharoshthi 4.
    statements, batch, size = [], [], len(head.encode())
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
        row_bytes = len(row.encode()) + 1
        if batch and size + row_bytes > MAX_STATEMENT_BYTES:
            statements.append(head + ",".join(batch) + ";")
            batch, size = [], len(head.encode())
        batch.append(row)
        size += row_bytes
    if batch:
        statements.append(head + ",".join(batch) + ";")
    return statements


class _PartWriter:
    """Writes statements to out_path, or, with a size cap, to out_path's stem + '-001.sql', '-002.sql'...
    starting a new part only between statements. Wrangler's local D1 drops the connection on a
    single file of a few hundred MB; parts of ~100 MB load reliably, in order."""

    def __init__(self, out_path: Path, max_bytes: int | None):
        self.out_path, self.max_bytes = out_path, max_bytes
        self.paths: list[Path] = []
        self.handle = None
        self.size = 0
        if max_bytes:
            for old in out_path.parent.glob(f"{out_path.stem}-*.sql"):
                old.unlink()
        self._next()

    def _next(self) -> None:
        if self.handle:
            self.handle.close()
        path = (self.out_path.with_name(f"{self.out_path.stem}-{len(self.paths) + 1:03d}.sql")
                if self.max_bytes else self.out_path)
        self.paths.append(path)
        self.handle = path.open("w", encoding="utf-8")
        self.size = 0

    def write(self, text: str) -> None:
        n = len(text.encode())
        if self.max_bytes and self.size and self.size + n > self.max_bytes:
            self._next()
        self.handle.write(text)
        self.size += n

    def close(self) -> None:
        self.handle.close()


def export(db_path: Path, out_path: Path, max_bytes: int | None = None) -> dict[str, int]:
    """`max_bytes`: split the SQL into numbered parts of about this size (see _PartWriter)."""
    db = sqlite3.connect(db_path)
    tables, indexes, virtual = _objects(db)
    counts: dict[str, int] = {}
    out = _PartWriter(out_path, max_bytes)
    try:
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
    finally:
        out.close()
    db.close()
    export.paths = out.paths
    return counts
