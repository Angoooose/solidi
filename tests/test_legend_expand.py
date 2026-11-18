from pathlib import Path

import pytest

from pipeline.legend_expand import Dictionary, coverage, expand, ordinal, roman_value

SAMPLE = Dictionary({
    "phrases": {
        "P M": {"latin": "Pontifex Maximus", "english": "chief priest", "kind": "title"},
        "TR P": {"latin": "Tribunicia Potestate", "english": "tribunician power", "kind": "title", "numbered": "year"},
        "P P": {"latin": "Pater Patriae", "english": "Father of his Country", "kind": "title"},
        "S P Q R": {"latin": "Senatus Populusque Romanus", "english": "the Senate and People of Rome", "kind": "formula"},
    },
    "words": {
        "IMP": {"latin": "Imperator", "english": "Emperor", "kind": "title", "numbered": "acclamation"},
        "COS": {"latin": "Consul", "english": "consul", "kind": "title", "numbered": "times"},
        "TRAIANO": {"latin": "Traiano", "english": "Trajan", "kind": "name", "lemma": "Traianus"},
        "AVG": {"latin": "Augustus", "english": "Augustus", "kind": "title"},
    },
})


def test_roman_numerals():
    assert [roman_value(t) for t in ("I", "IV", "V", "IX", "XIV", "XL", "XCIX")] == [1, 4, 5, 9, 14, 40, 99]
    assert roman_value("AVG") is None and roman_value("") is None
    assert [ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22)] == [
        "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]


def test_longest_phrase_wins_and_numbers_attach():
    segs = expand("IMP TRAIANO AVG P M TR P VII COS V P P", SAMPLE)
    assert [s.text for s in segs] == ["IMP", "TRAIANO", "AVG", "P M", "TR P VII", "COS V", "P P"]
    assert segs[4].english == "tribunician power (7th year)" and segs[4].number == 7
    assert segs[5].english == "consul for the 5th time"
    assert segs[0].english == "Emperor" and segs[0].number is None   # IMP followed by a name, not a numeral
    assert coverage(segs) == 1.0


def test_unknown_words_are_kept_not_guessed():
    segs = expand("S P Q R OPTIMO PRINC", SAMPLE)
    assert segs[0].text == "S P Q R"
    assert [s.kind for s in segs[1:]] == ["unknown", "unknown"]
    assert segs[1].latin is None and coverage(segs) == pytest.approx(4 / 6)


def test_free_numerals_only_when_multi_letter():
    segs = expand("VOT XX", SAMPLE)
    assert segs[1].kind == "numeral" and segs[1].number == 20
    assert expand("C", SAMPLE)[0].kind == "unknown"   # single 'C' is usually Gaius, never guess


def test_real_dictionary_parses():
    path = Path(__file__).resolve().parent.parent / "data" / "legend_abbreviations.yaml"
    if not path.exists():
        pytest.skip("no dictionary yet")
    d = Dictionary.load(path)
    assert d.words and d.phrases
    for entry in [*d.words.values(), *d.phrases.values()]:
        assert entry.get("latin") and entry.get("english") and entry.get("kind")
        assert entry.get("numbered") in (None, "times", "year", "acclamation")


CONTEXT = Dictionary({
    "words": {
        "VICTORIA": {"latin": "Victoria", "english": "Victory", "kind": "personification"},
        "AVG": {"latin": "Augustus", "english": "emperor", "kind": "title"},
        "SABINA": {"latin": "Sabina", "english": "Sabina", "kind": "name", "gender": "f"},
        "HADRIANVS": {"latin": "Hadrianus", "english": "Hadrian", "kind": "name"},
        "F": {"latin": "Filius", "english": "son", "kind": "word"},
        "GERMANICI": {"latin": "Germanici", "english": "Germanicus", "kind": "name"},
        "AGRIPPINA": {"latin": "Agrippina", "english": "Agrippina", "kind": "name", "gender": "f"},
    },
})


def test_avg_is_genitive_after_a_personification():
    segs = expand("VICTORIA AVG", CONTEXT)
    assert (segs[1].latin, segs[1].english) == ("Augusti", "of the Emperor")


def test_avg_and_f_are_feminine_after_a_womans_name():
    assert expand("SABINA AVG", CONTEXT)[1].latin == "Augusta"
    assert expand("HADRIANVS AVG", CONTEXT)[1].latin == "Augustus"
    segs = expand("AGRIPPINA AVG GERMANICI F", CONTEXT)
    assert segs[1].latin == "Augusta"
    # F follows Germanicus (male) inside a woman's legend: she is his daughter.
    assert segs[3].latin == "Filia"
    assert expand("HADRIANVS GERMANICI F", CONTEXT)[2].latin == "Filius"


# Regression cases from review, against the real dictionary.
REAL = Path(__file__).resolve().parent.parent / "data" / "legend_abbreviations.yaml"


@pytest.fixture(scope="module")
def real():
    if not REAL.exists():
        pytest.skip("no dictionary")
    return Dictionary.load(REAL)


def gloss(text, d):
    from pipeline.legends import normalise
    return expand(normalise(text), d)


def test_additive_numerals(real):
    segs = gloss("TR POT XIX COS IIII", real)
    assert any(s.number == 4 and "4th time" in s.english for s in segs)
    assert gloss("VOT XXX MVLT XXXX", real)[-1].number == 40


def test_praenomen_after_imp_is_not_a_number(real):
    for legend in ("IMP M IVL PHILIPPVS AVG", "IMP L SEPT SEV PERT AVG", "IMP C M AVR PROBVS AVG"):
        assert all((s.number or 0) < 100 for s in gloss(legend, real)), legend
    assert not any(s.kind == "numeral" and s.number and s.number > 100 for s in gloss("DIV CONSTANTINVS", real))


def test_empress_legends_are_feminine(real):
    english = " · ".join(s.english or "" for s in gloss("D N GALLA PLACIDIA P F AVG", real))
    assert "our Lady" in english and "Augusta" in english and "Augustus" not in english
    segs = gloss("DOMITIAE AVG IMP CAES DIVI F DOMITIAN AVG", real)
    assert segs[1].latin == "Augusta" and segs[-1].latin == "Augustus"


def test_avg_after_filiation_stays_the_subjects_title(real):
    assert gloss("IMP T CAES DIVI VESP F AVG", real)[-1].english != "of the Emperor"
    assert gloss("VICTORIA AVG", real)[-1].english == "of the Emperor"


def test_review_round_two_regressions(real):
    # Men are never feminised by a dative -ae (NERVAE) or by a woman named later in the legend.
    assert "Augusta" not in [s.latin for s in gloss("IMP CAES NERVAE TRAIANO AVG GER DAC", real)]
    segs = gloss("CAES AVG GERMA DAC COS VI P P MATIDIA AVG", real)
    assert segs[1].latin == "Augustus" and segs[-1].latin == "Augusta"
    # Late empresses: AEL is skipped when finding the subject.
    assert gloss("AEL PVLCHERIA AVG", real)[-1].latin == "Augusta"
    assert gloss("AEL PVLCHERIA AVG", real)[0].latin == "Aelia"
    # AVG right after a woman's name, whoever the subject is.
    assert gloss("IMP ALEXANDER PIVS AVG IVLIA MAMAEA AVG MATER AVG", real)[3].latin == "Augustus"
    assert [s for s in gloss("IMP ALEXANDER PIVS AVG IVLIA MAMAEA AVG MATER AVG", real) if s.text == "MAMAEA"]
    segs = gloss("IMP ALEXANDER PIVS AVG IVLIA MAMAEA AVG MATER AVG", real)
    i = [s.text for s in segs].index("MAMAEA")
    assert segs[i + 1].latin == "Augusta"
    # Son of the Emperor; imperial Hope.
    assert gloss("CAESAR AVG F DOMITIAN", real)[1].english == "of the Emperor"
    assert gloss("SPES AVGVSTA", real)[-1].english == "imperial"


def test_moneyer_names_come_from_the_issuer(real):
    from pipeline.legends import normalise
    segs = expand(normalise("C\u00b7ABVRI ROMA"), real, ["C. Aburius Geminus"])
    assert [s.latin for s in segs[:2]] == ["Gaius", "Aburius"]
    assert expand("SISENA", real, ["Cn. Cornelius Sisenna"])[0].kind == "unknown"   # spelled differently
    assert expand("SISENNA", real, ["Cn. Cornelius Sisenna"])[0].latin == "Sisenna"
    # The dictionary always wins: GEM is the legion title Gemina there.
    assert expand("GEM", real, ["C. Aburius Geminus"])[0].latin == "Gemina"
    segs = expand("P MAE ROMA", real, ["P. Maenius Antiaticus"])
    assert [s.latin for s in segs[:2]] == ["Publius", "Maenius"]
    # Without that issuer, a lone P stays unknown rather than guessed.
    assert expand("P MAE ROMA", real, ["C. Aburius Geminus"])[0].kind == "unknown"
    # Two-letter words never match a name by prefix.
    assert expand("MA ROMA", real, ["C. Aburius Geminus", "M. Marcius"])[0].kind == "unknown"


def test_republican_offices_and_genitive_names(real):
    from pipeline.legends import normalise
    segs = expand(normalise("C·CAESAR·IMP·III·VIR·R·P·C"), real)
    assert segs[-1].english == "triumvir for restoring the Republic"
    assert not any(s.number == 3 for s in segs)
    segs = expand(normalise("C·CONSIDI PAETI"), real, ["C. Considius Paetus"])
    assert [s.latin for s in segs] == ["Gaius", "Considius", "Paetus"]
    assert expand("SERVEILI", real, ["C. Servilius"])[0].latin == "Servilius"


def test_editorial_marks_in_issuer_names_are_dropped(real):
    assert expand("OGVL", real, ["C. Ogul[nius]"])[0].latin == "Ogulnius"
    assert expand("FOVRI", real, ["(Furius) Purpurio"])[0].kind == "unknown"   # FOVRI is not FVRI
    assert expand("FVRI", real, ["(Furius) Purpurio"])[0].latin == "Furius"


@pytest.fixture(scope="module")
def republic(real):
    import yaml
    overlay = REAL.parent / "legend_abbreviations_republic.yaml"
    return real.with_overlay(yaml.safe_load(overlay.read_text()))


def rep(text, d, names=None):
    from pipeline.legends import normalise
    return expand(normalise(text), d, names, republic=True)


def test_republican_senses_from_review(republic):
    """Cases from the CRRO gloss review: Imperial senses must not leak into Republican coins."""
    assert rep("C CASSI IMP", republic, ["Gaius Cassius Longinus"])[-1].english == "imperator (victorious general)"
    assert rep("IMP CAESAR DIVI F", republic)[0].english == "Imperator Caesar"
    assert rep("ANT AVG III VIR R P C", republic)[0].latin == "Antonius"
    assert rep("C CAESAR COS PONT AVG", republic)[-1].latin == "Augur"
    assert rep("ROMA", republic)[0].english == "Rome"
    assert rep("ANT AVG IMP III V R P C", republic)[-1].english == "triumvir for restoring the Republic"
    # A moneyer's own name beats a generic dictionary word.
    assert rep("MAT ROMA", republic, ["Matienus"])[0].latin == "Matienus"
    assert rep("C TER LVC ROMA", republic, ["C. Terentius Lucanus"])[1].latin == "Terentius"
    # ...but never a formula or a numbered title.
    segs = rep("C CAESAR COS TER", republic, ["Julius Caesar"])
    assert [s.english for s in segs[-2:]] == ["consul", "for the third time"]


def test_quaestor_initialisms_and_filiation(republic, real):
    assert rep("NERI Q VRB", republic, ["Cn. Nerius"])[1].english == "quaestor"
    assert rep("Q LVTATI Q", republic, ["Q. Lutatius Cerco"])[0].latin == "Quintus"
    assert rep("Q LVTATI Q", republic, ["Q. Lutatius Cerco"])[-1].english == "quaestor"
    assert rep("T Q ROMA", republic)[1].kind == "unknown"
    assert rep("L P D A P", republic)[0].english == "under the Papirian law on the weight of the as"
    assert all(s.kind == "unknown" for s in rep("S X T", republic))
    segs = rep("C EGNATIVS CN F CN N", republic, ["C. Egnatius Maximus"])
    assert [s.english for s in segs[2:]] == ["son of Gnaeus", "grandson of Gnaeus"]
    # Imperial legends keep their readings.
    assert gloss("DIVI F", real)[-1].latin == "Divi Filius"
    assert gloss("IMP CAESAR TRAIANO", real)[0].english == "Emperor Caesar"


def test_legion_or_legate(real):
    assert gloss("P CARISIVS LEG AVGVSTI", real)[2].english == "legate"
    segs = gloss("ANT AVG III VIR R P C LEG V", real)
    assert segs[-2].english == "legion" and segs[-1].number == 5
