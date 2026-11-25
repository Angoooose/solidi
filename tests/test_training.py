import gzip
import sqlite3

from pipeline import training

POLICY = {
    "licences": ["odbl", "publicdomain", "cc0", "/by/", "/by-nc/", "/by-nc-sa/"],
    "excluded": {"bnf": "disputed"},
    "unconfirmed": {"bm": "page not read"},
}


def test_usable_follows_the_policy():
    by = "https://creativecommons.org/licenses/"
    assert training.usable("ans", "http://opendatacommons.org/licenses/odbl/", POLICY) == (True, "")
    assert training.usable("vienna", by + "by-nc-sa/3.0/de/deed.en", POLICY)[0]
    assert training.usable("dnb", by + "by-nc/4.0/", POLICY)[0]
    assert not training.usable("kenom", by + "by-nc-nd/4.0/", POLICY)[0]     # no derivatives
    assert not training.usable("swiss", by + "by-nc-nd/4.0", POLICY)[0]      # no trailing slash
    assert not training.usable("berlin", by + "by-sa/4.0/deed.en", POLICY)[0]
    assert not training.usable("ashmolean", "https://hcr.ashmus.ox.ac.uk/content/copyright", POLICY)[0]
    assert training.usable("rutgers", None, POLICY) == (False, "no licence stated")
    assert training.usable("bnf", by + "by/4.0/", POLICY) == (False, "disputed")
    assert training.usable("bm", by + "by-nc-sa/4.0/", POLICY) == (False, "licence not confirmed: page not read")


def test_training_file_holds_only_usable_photographed_coins(tmp_path):
    db = sqlite3.connect(tmp_path / "solidi.sqlite")
    db.executescript("""
        CREATE TABLE dataset (id TEXT PRIMARY KEY, slug TEXT, name TEXT, data_licence TEXT, image_licence TEXT);
        CREATE TABLE build_info (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE coin_type (id TEXT PRIMARY KEY, dataset_id TEXT, mint_id TEXT, obv_description TEXT,
                                rev_description TEXT, obv_legend TEXT, rev_legend TEXT, title TEXT);
        CREATE TABLE type_person (type_id TEXT, person_id TEXT, role TEXT);
        CREATE TABLE type_denomination (type_id TEXT, denomination_id TEXT);
        CREATE TABLE specimen (id TEXT PRIMARY KEY, dataset_id TEXT, weight_g REAL);
        CREATE TABLE specimen_type (specimen_id TEXT, type_id TEXT);
        CREATE TABLE image (id INTEGER PRIMARY KEY, specimen_id TEXT, side TEXT, url TEXT, iiif_service TEXT);
        INSERT INTO build_info VALUES ('built_at', '2026-11-22T04:48:25+00:00');
        INSERT INTO dataset VALUES
          ('ocre', 'ocre', 'OCRE', 'http://opendatacommons.org/licenses/odbl/', NULL),
          ('ans', NULL, 'ANS', 'http://opendatacommons.org/licenses/odbl/', NULL),
          ('vienna', NULL, 'Vienna', 'https://creativecommons.org/licenses/by-nc-sa/3.0/de/deed.en', NULL),
          ('bm', NULL, 'British Museum', 'http://creativecommons.org/licenses/by-nc-sa/4.0/', NULL),
          ('kenom', NULL, 'KENOM', 'http://creativecommons.org/licenses/by-nc-nd/4.0/', NULL);
        INSERT INTO coin_type VALUES ('ocre/1', 'ocre', 'rome', 'Head', 'Victory', 'IMP', 'COS', 'RIC 1'),
                                     ('ocre/2', 'ocre', 'rome', 'Head', 'Pax', 'IMP', 'COS', 'RIC 2');
        INSERT INTO type_person VALUES ('ocre/1', 'trajan', 'portrait_obverse'), ('ocre/2', 'trajan', 'portrait_obverse');
        INSERT INTO type_denomination VALUES ('ocre/1', 'denarius'), ('ocre/2', 'denarius');
        INSERT INTO specimen VALUES ('a', 'ans', 3.1), ('v', 'vienna', 3.0), ('b', 'bm', 3.2),
                                    ('k', 'kenom', 3.3), ('nophoto', 'ans', 3.0);
        INSERT INTO specimen_type VALUES ('a', 'ocre/1'), ('v', 'ocre/1'), ('b', 'ocre/2'), ('k', 'ocre/2'), ('nophoto', 'ocre/2');
        INSERT INTO image (specimen_id, side, url) VALUES ('a', 'obverse', 'u1'), ('v', 'obverse', 'u2'),
                                                          ('b', 'obverse', 'u3'), ('k', 'obverse', 'u4');
    """)
    db.commit()
    db.close()
    out, info = training.build_training(tmp_path, POLICY)

    assert out.name == "dataset.sqlite.gz"
    (tmp_path / "check.sqlite").write_bytes(gzip.decompress(out.read_bytes()))
    db = sqlite3.connect(tmp_path / "check.sqlite")
    assert [r[0] for r in db.execute("SELECT id FROM specimen ORDER BY id")] == ["a", "v"]
    assert [r[0] for r in db.execute("SELECT url FROM image ORDER BY url")] == ["u1", "u2"]
    # Only the type the kept coins belong to, and its labels; the catalogue stays for its slug.
    assert [r[0] for r in db.execute("SELECT id FROM coin_type")] == ["ocre/1"]
    assert db.execute("SELECT count(*) FROM type_person").fetchone()[0] == 1
    assert [r[0] for r in db.execute("SELECT id FROM dataset ORDER BY id")] == ["ans", "ocre", "vienna"]
    assert "do not publish" in dict(db.execute("SELECT key, value FROM readme"))["use"]
    assert info["used"] == [("ANS", 1), ("Vienna", 1)]
    assert ("British Museum", "licence not confirmed: page not read") in info["left_out"]
    assert ("KENOM", "licence does not allow it") in info["left_out"]
