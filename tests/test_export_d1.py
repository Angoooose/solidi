import sqlite3

from pipeline import export_d1


def _source(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE mint (id TEXT PRIMARY KEY, label TEXT);
        CREATE TABLE coin_type (
          id TEXT PRIMARY KEY, mint_id TEXT REFERENCES mint(id),
          parent_id TEXT REFERENCES coin_type(id), note TEXT);
        CREATE INDEX idx_type_mint ON coin_type(mint_id);
        CREATE TABLE legend (id INTEGER PRIMARY KEY, type_id TEXT REFERENCES coin_type(id), compact TEXT);
        CREATE VIRTUAL TABLE legend_fts USING fts5(compact, content='legend', content_rowid='id', tokenize='trigram');
    """)
    db.execute("INSERT INTO mint VALUES ('rome', 'Rome')")
    # Child inserted before its parent, quotes and NULLs, and enough text to force several INSERTs.
    db.execute("INSERT INTO coin_type VALUES ('t.1a', 'rome', 't.1', 'it''s a variant')")
    db.execute("INSERT INTO coin_type VALUES ('t.1', 'rome', NULL, NULL)")
    for i in range(300):
        db.execute("INSERT INTO legend (type_id, compact) VALUES (?, ?)", ("t.1", f"IMPTRAIANOAVG{i}" + "X" * 500))
    db.execute("INSERT INTO legend_fts (legend_fts) VALUES ('rebuild')")
    db.commit()
    db.close()


def test_round_trip(tmp_path):
    src, sql = tmp_path / "src.sqlite", tmp_path / "out.sql"
    _source(src)
    counts = export_d1.export(src, sql)
    assert counts == {"mint": 1, "coin_type": 2, "legend": 300}

    text = sql.read_text()
    assert "PRAGMA" not in text and "BEGIN" not in text
    assert "legend_fts_data" not in text
    assert text.count('INSERT INTO "legend"') > 1
    assert max(len(line) for line in text.splitlines()) < export_d1.MAX_STATEMENT_BYTES + 1000

    # Load twice with foreign keys enforced, as D1 does: the second load exercises the drops.
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(text)
    db.executescript(text)
    assert db.execute("SELECT note FROM coin_type WHERE id = 't.1a'").fetchone() == ("it's a variant",)
    hits = db.execute("SELECT count(*) FROM legend_fts WHERE compact LIKE '%TRAIANOAVG29%'").fetchone()
    assert hits == (11,)
