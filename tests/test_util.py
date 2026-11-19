from pipeline.stage import fix_predicate
from pipeline.util import (
    commercial_ok, entity_id, external_system, local_id, natural_key, parse_reference,
    reference_sort_key, normalise_uri, parse_ric_label, parse_year,
)

RULES = [
    {"match": "publicdomain", "commercial_ok": True},
    {"match": "-nc", "commercial_ok": False},
    {"match": "/by-sa/", "commercial_ok": True},
    {"match": "/by/", "commercial_ok": True},
    {"match": "odbl", "commercial_ok": True},
]


def test_normalise_uri_collapses_variants():
    expected = "http://numismatics.org/ocre/id/ric.2.tr.147"
    for variant in (
        "http://numismatics.org/ocre/id/ric.2.tr.147",
        "https://numismatics.org/ocre/id/ric.2.tr.147",
        "http://www.numismatics.org/ocre/id/ric.2.tr.147",
        "https://www.numismatics.org/ocre/id/ric.2.tr.147/",
    ):
        assert normalise_uri(variant) == expected


def test_local_id():
    assert local_id("http://nomisma.org/id/trajan") == "trajan"
    assert local_id("http://numismatics.org/ocre/id/ric.1(2).aug.1") == "ric.1(2).aug.1"
    assert local_id("http://nomisma.org/id/rome#this") == "rome"


def test_parse_year():
    assert parse_year("0103") == 103
    assert parse_year("-0027") == -27
    assert parse_year("0053-09-18") == 53
    assert parse_year(None) is None
    assert parse_year("unknown") is None


def test_parse_ric_label():
    assert parse_ric_label("RIC II Trajan 147") == ("RIC II", "147")
    assert parse_ric_label("RIC I (second edition) Augustus 1a") == ("RIC I (second edition)", "1a")
    assert parse_ric_label("RIC II.1 (second edition) Vespasian 10") == ("RIC II.1 (second edition)", "10")
    assert parse_ric_label("Something else") == (None, None)
    assert parse_ric_label("RIC II Trajan 22 (aureus)") == ("RIC II", "22")
    assert parse_ric_label("RIC II Trajan 134 (quinarius aureus)") == ("RIC II", "134")


def test_commercial_ok():
    assert commercial_ok("https://creativecommons.org/publicdomain/zero/1.0/", RULES)
    assert commercial_ok("https://creativecommons.org/licenses/by/4.0/", RULES)
    assert commercial_ok("http://opendatacommons.org/licenses/odbl/", RULES)
    assert not commercial_ok("https://creativecommons.org/licenses/by-nc-sa/4.0/", RULES)
    assert not commercial_ok("http://www.harvardartmuseums.org/terms-of-use", RULES)
    assert not commercial_ok(None, RULES)


def test_external_system():
    assert external_system("http://www.wikidata.org/entity/Q220") == "wikidata"
    assert external_system("https://pleiades.stoa.org/places/423025") == "pleiades"
    assert external_system("http://example.org/x") == "other"


def test_fix_predicate_repairs_missing_hash():
    assert fix_predicate("http://nomisma.org/ontologyhasWeight") == "http://nomisma.org/ontology#hasWeight"
    assert fix_predicate("http://nomisma.org/ontology#hasWeight") == "http://nomisma.org/ontology#hasWeight"


def test_clean_turtle_encodes_invalid_iri_chars():
    from pipeline.sparql import clean_turtle
    assert clean_turtle(r"<http://x.org/a b|c d> .") == "<http://x.org/a%20b%7Cc%20d> ."
    assert clean_turtle('<http://x.org/ok> "a | b" .') == '<http://x.org/ok> "a | b" .'


def test_parse_ric_label_parts():
    assert parse_ric_label("RIC II, Part 1 (second edition) Domitian 822") == ("RIC II, Part 1 (second edition)", "822")
    assert parse_ric_label("RIC II, Part 3 (second edition) Hadrian 10-11") == ("RIC II, Part 3 (second edition)", "10-11")


def test_plausibility_filters():
    from pipeline.util import plausible_url, plausible_weight
    assert not plausible_url("http://localhost:3030/nomisma/data?default")
    assert plausible_url("https://finds.org.uk/images/x/Roman%20coin.jpg")
    assert plausible_weight(0.0) is None
    assert plausible_weight(2141.0) is None
    assert plausible_weight(3.4) == 3.4


def test_wikidata_year_converts_astronomical_numbering():
    from pipeline.link.wikidata import wikidata_year
    assert wikidata_year("-0062-09-21T00:00:00Z") == -63   # Augustus, born 63 BC
    assert wikidata_year("0000-01-01T00:00:00Z") == -1     # astronomical year 0 = 1 BC
    assert wikidata_year("0053-09-18T00:00:00Z") == 53
    assert wikidata_year(None) is None


def test_entity_ids_are_namespaced_outside_nomisma():
    assert entity_id("http://nomisma.org/id/trajan", "nomisma") == "trajan"
    assert entity_id("https://data.corpus-nummorum.eu/api/monograms/840", "cn") == "cn/840"


def test_reference_parsing_per_work():
    assert parse_reference("ric", "RIC II Trajan 147") == ("RIC II", "147")
    assert parse_reference("rrc", "RRC 414/1") == (None, "414/1")
    assert parse_reference("price1991", "Price 153") == (None, "153")
    assert parse_reference("seleucid_coins", "Seleucid Coins (part 1) 1043.3") == (None, "1043.3")
    assert parse_reference("x", "No number here") == (None, None)


def test_natural_sort():
    nums = ["10a", "9", "100", "10"]
    assert sorted(nums, key=natural_key) == ["9", "10", "10a", "100"]
    vols = ["RIC X", "RIC II, Part 3", "RIC II", "RIC IV"]
    assert sorted(vols, key=natural_key) == ["RIC II", "RIC II, Part 3", "RIC IV", "RIC X"]
    assert reference_sort_key("RIC II", "9") < reference_sort_key("RIC II", "10") < reference_sort_key("RIC X", "1")
    # A volume that extends another sorts after it, whatever punctuation follows.
    assert reference_sort_key("RIC II", "999") < reference_sort_key("RIC II, Part 3 (second edition)", "1")
    assert reference_sort_key("RIC II", "999") < reference_sort_key("RIC II (second edition)", "1")


def test_wikidata_dates_need_year_precision():
    from pipeline.link.wikidata import exact
    assert exact({"birth": "-0300-01-01T00:00:00Z", "birth_precision": "9"}, "birth")
    assert not exact({"birth": "0500-01-01T00:00:00Z", "birth_precision": "7"}, "birth")   # 5th century
    assert not exact({"birth": "0500-01-01T00:00:00Z"}, "birth")


def test_local_nomisma_links_are_repaired():
    from pipeline.util import repair_uri
    assert repair_uri("http://localhost:8080/fuseki/nomisma/aristai_athens") == "http://nomisma.org/id/aristai_athens"
    assert repair_uri("http://localhost:8080/fuseki/nomisma/data?graph=default") == "http://localhost:8080/fuseki/nomisma/data?graph=default"
    assert repair_uri("http://nomisma.org/id/rome") == "http://nomisma.org/id/rome"
