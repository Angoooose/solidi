from pipeline.search import index_terms, tokens


def test_tokens_keep_numbers_whole():
    assert tokens("RRC 494/23") == ["rrc", "494/23"]
    assert tokens("Coins of the Ptolemaic Empire Vol. I, Part 1, no. 394") == [
        "coins", "of", "the", "ptolemaic", "empire", "vol", "i", "part", "1", "no", "394"]


def test_tokens_fold_accents_and_case():
    assert tokens("Münzkabinett ΑΒ Caesarea") == ["munzkabinett", "caesarea"]


def test_index_terms_add_the_volume_in_arabic():
    assert index_terms("RIC II Trajan 22", "RIC II") == ["ric", "ii", "trajan", "22", "2"]
    terms = index_terms("RIC II, Part 3 (second edition) Hadrian 101", "RIC II, Part 3 (second edition)")
    assert terms[-2:] == ["2", "2.3"]


def test_index_terms_leave_regnal_numerals_alone():
    # 'RIC 2 22' must not also find Valerian II's 22.
    assert "2" not in index_terms("RIC V Valerian II 22", "RIC V")
