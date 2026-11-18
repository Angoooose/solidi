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
