import gzip
import sqlite3

from pipeline import release

ALLOWED = ["odbl", "publicdomain", "cc0", "/by/"]


def _source(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE dataset (id TEXT PRIMARY KEY, slug TEXT, name TEXT, data_licence TEXT, image_licence TEXT, commercial_ok INTEGER NOT NULL);
        CREATE TABLE build_info (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE coin_type (id TEXT PRIMARY KEY, dataset_id TEXT, parent_id TEXT);
        CREATE TABLE legend (id INTEGER PRIMARY KEY, type_id TEXT, compact TEXT);
        CREATE VIRTUAL TABLE legend_fts USING fts5(compact, content='legend', content_rowid='id');
        CREATE TABLE type_match (type_id TEXT, uri TEXT, relation TEXT, target_type_id TEXT, PRIMARY KEY (type_id, uri));
        CREATE TABLE specimen (id TEXT PRIMARY KEY, dataset_id TEXT);
        CREATE TABLE specimen_type (specimen_id TEXT, type_id TEXT, PRIMARY KEY (specimen_id, type_id));
        CREATE TABLE image (id INTEGER PRIMARY KEY, specimen_id TEXT, url TEXT);
        CREATE TABLE article (entity_id TEXT, extract TEXT);
        CREATE TABLE holder_stat (institution_id TEXT, photographed INTEGER);
        INSERT INTO build_info VALUES ('built_at', '2026-11-22T04:48:25+00:00');
        INSERT INTO dataset VALUES
          ('ocre', 'ocre', 'OCRE', 'http://opendatacommons.org/licenses/odbl/', NULL, 1),
          ('cn', 'cn', 'Corpus<br> Nummorum', 'http://creativecommons.org/licenses/by-nc-sa/3.0/', NULL, 0),
          ('pas', NULL, 'PAS', 'http://creativecommons.org/licenses/by/3.0/', NULL, 1),
          ('berlin', NULL, 'Berlin', 'https://creativecommons.org/licenses/by-sa/4.0/deed.en', NULL, 0),
          ('ashmolean', NULL, 'Ashmolean', 'https://hcr.ashmus.ox.ac.uk/content/copyright', NULL, 0);
        INSERT INTO coin_type VALUES ('ocre/1', 'ocre', NULL), ('cn/1', 'cn', NULL), ('cn/1a', 'cn', 'cn/1');
        INSERT INTO legend (type_id, compact) VALUES ('ocre/1', 'IMPTRAIANO'), ('cn/1', 'BASILEOS');
        INSERT INTO type_match VALUES ('ocre/1', 'x', 'exact', 'cn/1');
        INSERT INTO specimen VALUES ('s-pas', 'pas'), ('s-berlin', 'berlin'), ('s-ash', 'ashmolean'), ('s-pas-cn', 'pas');
        INSERT INTO specimen_type VALUES ('s-pas', 'ocre/1'), ('s-berlin', 'ocre/1'), ('s-ash', 'ocre/1'), ('s-pas-cn', 'cn/1');
        INSERT INTO image (specimen_id, url) VALUES ('s-pas', 'a'), ('s-berlin', 'b'), ('s-ash', 'c'), ('s-pas-cn', 'd');
        INSERT INTO article VALUES ('trajan', 'Trajan was...');
        INSERT INTO legend_fts (legend_fts) VALUES ('rebuild');
    """)
    db.commit()
    db.close()


def test_releasable():
    assert release.releasable("http://opendatacommons.org/licenses/odbl/", ALLOWED)
    assert release.releasable("http://creativecommons.org/licenses/by/3.0/", ALLOWED)
    assert release.releasable("https://creativecommons.org/publicdomain/zero/1.0/", ALLOWED)
    assert not release.releasable("https://creativecommons.org/licenses/by-sa/4.0/", ALLOWED)
    assert not release.releasable("http://creativecommons.org/licenses/by-nc-sa/3.0/", ALLOWED)
    assert not release.releasable("https://hcr.ashmus.ox.ac.uk/content/copyright", ALLOWED)
    assert not release.releasable(None, ALLOWED)


def test_slim_keeps_only_odbl_compatible_data(tmp_path):
    _source(tmp_path / "solidi.sqlite")
    info = release.slim(tmp_path / "solidi.sqlite", tmp_path / "out.sqlite", ALLOWED)
    db = sqlite3.connect(tmp_path / "out.sqlite")
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert not tables & {"legend_fts", "legend_fts_data", "article", "holder_stat"}
    assert "readme" in tables
    assert [r[0] for r in db.execute("SELECT id FROM coin_type")] == ["ocre/1"]
    assert [r[0] for r in db.execute("SELECT type_id FROM legend")] == ["ocre/1"]
    assert db.execute("SELECT target_type_id FROM type_match").fetchone() == (None,)
    # Berlin (BY-SA) and the Ashmolean (own terms) leave; so does a PAS coin linked only to a CN type.
    assert [r[0] for r in db.execute("SELECT id FROM specimen")] == ["s-pas"]
    assert [r[0] for r in db.execute("SELECT url FROM image")] == ["a"]
    assert sorted(r[0] for r in db.execute("SELECT id FROM dataset")) == ["ocre", "pas"]
    assert info["after"] == {"coin_type": 1, "specimen": 1, "image": 1}


def test_build_release_writes_gzip_checksum_and_notes(tmp_path):
    _source(tmp_path / "solidi.sqlite")
    out_dir, _ = release.build_release(tmp_path, ALLOWED)
    raw = gzip.decompress((out_dir / release.ASSET).read_bytes())
    assert raw.startswith(b"SQLite format 3")
    assert (out_dir / f"{release.ASSET}.sha256").read_text().endswith(f"  {release.ASSET}\n")
    notes = (out_dir / "NOTES.md").read_text()
    assert "- Corpus Nummorum: CC BY-NC-SA 3.0" in notes
    assert "- PAS: CC BY 3.0" in notes
    assert not (out_dir / "solidi.sqlite").exists()
