import sqlite3

from pipeline import images


def test_flag_unusable_hides_hosts_and_collections():
    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE specimen (id TEXT PRIMARY KEY, dataset_id TEXT);
        CREATE TABLE image (id INTEGER PRIMARY KEY, specimen_id TEXT, url TEXT, thumbnail_url TEXT, usable INTEGER NOT NULL DEFAULT 1);
        INSERT INTO specimen VALUES ('a', 'https://ans/'), ('b', 'https://ashmolean/'), ('c', 'https://ans/');
        INSERT INTO image (specimen_id, url) VALUES ('a', 'https://ans.org/1.jpg'), ('b', 'https://ashmolean.org/2.jpg'),
                                                    ('c', 'https://gallica.bnf.fr/3.jpg');
    """)
    config = {"unusable_image_hosts": [{"host": "gallica.bnf.fr"}],
              "hidden_image_datasets": [{"id": "https://ashmolean/"}]}
    assert images.flag_unusable(db, config, log=lambda _: None) == 2
    assert [r[0] for r in db.execute("SELECT specimen_id FROM image WHERE usable = 1")] == ["a"]
    assert db.execute("SELECT count(*) FROM specimen").fetchone() == (3,)
