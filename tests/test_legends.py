from pipeline.legends import compact, normalise


def test_line_breaks_join_words():
    assert normalise("D N HONORI-VS P F AVG") == "D N HONORIVS P F AVG"
    assert normalise("VICTORIA - AVGVSTORV_M") == "VICTORIA AVGVSTORVM"


def test_dividers_and_field_separators():
    assert normalise("D N THEODOSI-VS•P•F•AVG") == "D N THEODOSIVS P F AVG"
    assert normalise("D N MARCIA-NVS˙P˙F˙AVG") == "D N MARCIANVS P F AVG"
    assert normalise("COS III P P // S C") == "COS III P P S C"


def test_restorations_and_editorial_notes():
    assert normalise("DOMINIS NOS-[TRIS….]") == "DOMINIS NOSTRIS"
    assert normalise("D N PROC A(rev.N)-THEMIVS P F AVG") == "D N PROC ATHEMIVS P F AVG"


def test_special_letters():
    assert normalise("D N ANTHEMI-VS PERPET Ꜹ") == "D N ANTHEMIVS PERPET AV"
    assert normalise("D N VAL-∈N AVG") == "D N VALEN AVG"
    assert normalise("IMP CAESAR TRAJANUS") == "IMP CAESAR TRAIANVS"


def test_compact_ignores_spacing():
    assert compact("TR P COS") == compact("TRP COS") == "TRPCOS"


def test_middle_dot_separates_words():
    from pipeline.legends import normalise
    assert normalise("CN\u00b7DOM ROMA") == "CN DOM ROMA"


def test_latin_letter_forms_are_not_greek():
    from pipeline.legends import language
    assert language("AEL \u03e4ERI-NA A\u03e4G") == "la"
    assert language("D N \u039bEONS P F AVG") == "la"
    assert language("\u0392\u0391\u03a3\u0399\u039b\u0395\u03a9\u03a3") == "grc"


def test_greek_legends_fold_and_romanise():
    from pipeline.legends import compact, language, normalise, romanised
    assert language("BA\u03a3\u0399\u039b\u0395\u03a9\u03a3 ANTIOXOY") == "grc"
    sco = normalise("BA\u03a3\u0399\u039b\u0395\u03a9\u03a3 ANTIOXOY", "grc")
    assert sco == normalise("\u0392\u0391\u03a3\u0399\u039b\u0395\u03a9\u03a3 \u0391\u039d\u03a4\u0399\u039f\u03a7\u039f\u03a5", "grc")
    assert sco == normalise("\u03b2\u03b1\u03c3\u03b9\u03bb\u03ad\u03c9\u03c2 \u1f08\u03bd\u03c4\u03b9\u03cc\u03c7\u03bf\u03c5", "grc")   # accented lowercase
    assert normalise("\u0391\u0398\u0397\u039d\u0391\u03f9", "grc") == "\u0391\u0398\u0397\u039d\u0391\u03a3"   # lunate sigma
    assert romanised(sco) == "BASILEOSANTIOCHOV"
    assert compact("antiochou") == "ANTIOCHOV"
    assert normalise("ANTIOXOV", "grc") == normalise("ANTIOXOY", "grc")    # OY ligature typed as V


def test_other_scripts_and_cataloguer_notes():
    from pipeline.legends import language, normalise, romanised
    kh = "\U00010A28\U00010A31\U00010A2A\U00010A17\U00010A2F"            # maharajasa
    assert language(kh, "grc") == "pgd"
    assert romanised(normalise(kh, "pgd"), "pgd") == "MAHARAIASA"     # J -> I, as Latin search normalises
    assert language("ANTIOX", "grc") == "grc" and language("ANTIOX") == "la"
    assert language("Illegible inscription", "grc") == "zxx"
    assert language("IMP CAES TRAIANO", "la") == "la"


def test_bilingual_greek_phoenician_counts_as_greek():
    from pipeline.legends import language, normalise
    legend = "BAΣΙΛΕΩΣ ANTIOXOY\U00010913‬\U0001090C\U0001090B‬"
    assert language(legend, "grc") == "grc"
    assert normalise(legend, "grc").startswith("ΒΑΣΙΛΕΩΣ ΑΝΤΙΟΧΟΥ")


def test_greek_cataloguer_notes_and_typing_slips():
    from pipeline.legends import normalise
    assert normalise("\u03a0\u03a4\u039f\u039b\u0395\u039c\u0391\u0399\u039f\u03a5 on l. \u0392\u0391\u03a3\u0399\u039b\u0395\u03a9\u03a3 on r.", "grc") == \
        "\u03a0\u03a4\u039f\u039b\u0395\u039c\u0391\u0399\u039f\u03a5 \u0392\u0391\u03a3\u0399\u039b\u0395\u03a9\u03a3"
    alexandrou = "\u0391\u039b\u0395\u039e\u0391\u039d\u0394\u03a1\u039f\u03a5"
    assert normalise("ALEXAN\u0394POY", "grc") == alexandrou        # Latin L and X typed for \u039b, \u039e
    assert normalise("\u0424\u0399\u039b", "grc") == "\u03a6\u0399\u039b"     # Cyrillic \u0424


def test_latin_legend_with_greek_workshop_numeral_is_latin():
    from pipeline.legends import language
    assert language("CONCOR-DIA AVGGG\u03b8") == "la"
    assert language("BA\u03a3\u0399\u039b\u0395\u03a9\u03a3 ANTIOXOV", "grc") == "grc"


def test_greek_alternative_readings_keep_the_first():
    from pipeline.legends import normalise
    assert normalise("BAC\u0399 or BACI\u039b A\u039bE\u039e or A\u039bE\u039eA", "grc") == "\u0392\u0391\u03a3\u0399 \u0391\u039b\u0395\u039e"


def test_cn_resolved_letters_and_ligatures_stay_in_the_word():
    from pipeline.legends import normalise
    g = lambda s: normalise(s, "grc")
    assert g("\u039a\u0391\u0399(\u03f9)") == "\u039a\u0391\u0399\u03a3"
    assert g("\u039d\u0395\u03a9\u039a\u039f\u03a1(\u03a9,\u039f)V") == "\u039d\u0395\u03a9\u039a\u039f\u03a1\u03a9\u03a5"
    assert g("\u0391\u039d\u03a4\u03a9*\u039d\u0395*\u0399\u039d\u039f\u03f9") == "\u0391\u039d\u03a4\u03a9\u039d\u0395\u0399\u039d\u039f\u03a3"
    assert g("\u039a\u03a5\u30a8\u0399\u039a\u0397\u039d\u03a9\u039d") == "\u039a\u03a5\u0396\u0399\u039a\u0397\u039d\u03a9\u039d"
    assert normalise("C IVL VER MAXIMVS C(A)ES") == "C IVL VER MAXIMVS CAES"
    assert normalise("IMP CAES (rev.N) TRAIANO") == "IMP CAES TRAIANO"      # editorial notes still go


def test_places():
    from pipeline.legends import places, _place_segments
    assert places("SALVS AVGVSTI // COS III (in exergue) // S C (in field)") == [
        ("around", "SALVS AVGVSTI"), ("exergue", "COS III"), ("field", "S C")]
    assert places("ΠΤΟΛΕΜΑΙΟΥ on l., ΒΑΣΙΛΕΩΣ on r.") == [("left field", "ΠΤΟΛΕΜΑΙΟΥ"), ("right field", "ΒΑΣΙΛΕΩΣ")]
    assert places("IMP TRAIANO AVG") == [(None, "IMP TRAIANO AVG")]
    rows = [{"text": "SALVS"}, {"text": "AVGVSTI"}, {"text": "COS III"}, {"text": "S C"}]
    _place_segments(rows, "SALVS AVGVSTI // COS III (in exergue) // S C (in field)", "la")
    assert [r.get("place") for r in rows] == ["around", "around", "exergue", "field"]
    # A segment spanning two parts leaves the whole legend unplaced.
    rows = [{"text": "SALVS AVGVSTI COS"}, {"text": "III"}, {"text": "S C"}]
    _place_segments(rows, "SALVS AVGVSTI // COS III (in exergue) // S C (in field)", "la")
    assert all("place" not in r for r in rows)
