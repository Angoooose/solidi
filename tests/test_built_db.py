"""Checks against a built database (run `uv run solidi build --authority trajan` first).

These hold for both the Trajan slice and a full OCRE build.
"""

import sqlite3
from pathlib import Path

import pytest

DB = Path(__file__).resolve().parent.parent / "build" / "solidi.sqlite"
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built database")


@pytest.fixture(scope="module")
def db():
    conn = sqlite3.connect(DB)
    yield conn
    conn.close()


def one(db, sql, *args):
    return db.execute(sql, args).fetchone()


def test_known_type(db):
    row = one(db, """SELECT title, ric_volume, ric_number, start_year, end_year, mint_id, obv_legend
                     FROM coin_type WHERE id = 'ric.2.tr.147'""")
    assert row == ("RIC II Trajan 147", "RIC II", "147", 103, 111, "rome",
                   "IMP TRAIANO AVG GER DAC P M TR P")


def test_known_type_relations(db):
    roles = {r for r, in db.execute("SELECT role FROM type_person WHERE type_id='ric.2.tr.147' AND person_id='trajan'")}
    assert roles == {"authority", "portrait_obverse"}
    assert one(db, "SELECT denomination_id FROM type_denomination WHERE type_id='ric.2.tr.147'") == ("denarius",)
    assert one(db, "SELECT COUNT(*) FROM specimen_type WHERE type_id='ric.2.tr.147'")[0] >= 3


def test_trajan_reign_and_links(db):
    assert one(db, "SELECT start_year, end_year FROM person WHERE id='trajan'") == (98, 117)
    assert one(db, "SELECT COUNT(*) FROM external_id WHERE entity_id='trajan' AND system='viaf'")[0] == 1


def test_rome_has_coordinates_and_pleiades(db):
    lat, lon = one(db, "SELECT lat, lon FROM mint WHERE id='rome'")
    assert round(lat) == 42 and round(lon) == 12
    assert one(db, "SELECT uri FROM external_id WHERE entity_id='rome' AND system='pleiades'") == (
        "https://pleiades.stoa.org/places/423025",)


def test_reverse_subjects_from_source(db):
    victory_types = one(db, "SELECT COUNT(*) FROM type_subject WHERE subject_id='victory' AND side='reverse'")[0]
    assert victory_types > 100
    assert one(db, "SELECT kind FROM subject WHERE id='victory'") == ("deity",)


def test_uncertain_mint_is_flagged_not_dropped(db):
    # 'uncertain_value' is Nomisma's placeholder, never a real mint; "Rome, uncertain" keeps Rome + flag.
    assert one(db, "SELECT COUNT(*) FROM mint WHERE id = 'uncertain_value'")[0] == 0
    assert one(db, "SELECT COUNT(*) FROM coin_type WHERE mint_uncertain=1")[0] > 0


def test_hoard_groups_are_not_specimens(db):
    # dcmitype:Collection records (hoard contents) must not appear as specimens.
    assert one(db, "SELECT COUNT(*) FROM specimen WHERE source_uri LIKE '%chre%'")[0] == 0


def test_every_dataset_has_commercial_flag(db):
    assert one(db, "SELECT COUNT(*) FROM dataset WHERE commercial_ok NOT IN (0, 1)")[0] == 0
    assert one(db, "SELECT commercial_ok FROM dataset WHERE id='http://www.metmuseum.org/'") == (1,)
    assert one(db, "SELECT commercial_ok FROM dataset WHERE id='http://www.fitzmuseum.cam.ac.uk/'") == (0,)


def test_nested_uncertain_mint_resolves(db):
    # Source: [ rdf:value nm:rome ; un:hasUncertainty nm:uncertain_value ]
    if one(db, "SELECT COUNT(*) FROM coin_type WHERE id='ric.2_1(2).dom.822'")[0]:
        assert one(db, "SELECT mint_id, mint_uncertain FROM coin_type WHERE id='ric.2_1(2).dom.822'") == ("rome", 1)


def test_every_type_has_a_ric_reference(db):
    assert one(db, "SELECT COUNT(*) FROM coin_type WHERE ric_number IS NULL")[0] == 0


def test_no_placeholder_images_or_zero_weights(db):
    assert one(db, "SELECT COUNT(*) FROM image WHERE url LIKE '%localhost%'")[0] == 0
    assert one(db, "SELECT COUNT(*) FROM specimen WHERE weight_g <= 0 OR weight_g > 500")[0] == 0
