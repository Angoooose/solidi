"""Greek legend normalisation and romanisation.

Sources type Greek legends inconsistently. SCO often uses Latin letters that look Greek
('BAΣΙΛΕΩΣ ANTIOXOY': B, A, N, T, I, O, X, Y are Latin), letter forms vary (lunate sigma Ϲ,
Є, ∈), and some records carry accents. Normalising maps all of it to plain uppercase Greek,
so 'ANTIOXOY', 'ΑΝΤΙΟΧΟΥ' and 'Ἀντιόχου' compare equal; `romanise` gives the Latin-letter
form collectors type ('ANTIOCHOU').
"""

from __future__ import annotations

import re
import unicodedata

# Latin capitals that stand in for Greek ones, plus Greek letter variants.
LOOKALIKE = {
    "A": "Α", "B": "Β", "E": "Ε", "Z": "Ζ", "H": "Η", "I": "Ι", "K": "Κ", "M": "Μ",
    "N": "Ν", "O": "Ο", "P": "Ρ", "T": "Τ", "Y": "Υ", "X": "Χ", "C": "Σ",
    "V": "Υ", "U": "Υ", "Ȣ": "ΟΥ",     # late Seleucid ΟΥ ligature, typed as V (ANTIOXOV)
    # Once cataloguers' notes are gone, any other Latin capital is a stand-in for a Greek one.
    "L": "Λ", "D": "Δ", "G": "Γ", "S": "Σ", "F": "Φ", "R": "Ρ",
    "Ϲ": "Σ", "ϲ": "Σ", "Ϛ": "ΣΤ", "Є": "Ε", "∈": "Ε", "Ɛ": "Ε", "ϵ": "Ε", "ς": "Σ",
    "Ϳ": "Ι", "Ꞷ": "Ω", "W": "Ω", "Ф": "Φ", "ф": "Φ",     # Cyrillic Ф typed for Φ (ФΙΛΕΤΑΙΡΟΥ)
    "ᛈ": "Σ", "エ": "Ζ",     # CN: runic ᛈ for lunate sigma, katakana エ for Ζ (ΚΥエΙΚΗΝΩΝ)
}

# Typing slips that change a letter, fixed so search finds them: Latin X typed for Ξ in
# ΑΛΕΞΑΝΔΡΟΥ (the look-alike map reads X as Χ, right for ΑΝΤΙΟΧΟΥ, wrong here).
SPELLINGS = {"ΑΛΕΧΑΝΔΡ": "ΑΛΕΞΑΝΔΡ"}

# Cataloguers' notes inside Greek legends (PCO: 'ΠΤΟΛΕΜΑΙΟΥ on l. ΒΑΣΙΛΕΩΣ on r.',
# 'A with ΛΕ ligature', 'ΠΤΟ below'): lowercase Latin words, never legend text.
_ALTERNATIVE = re.compile(r"\s+or\s+\S+")
_NOTE_WORDS = re.compile(r"(?<![A-Za-z])[a-z]+\.?(?![A-Za-z])")
# Greek run straight into Phoenician (ΣΙΔΩΝΙΩΝ𐤌𐤍𐤃𐤑𐤋): split the scripts into separate words.
_SCRIPT_JOIN = re.compile(r"(?<=[\u0370-\u03ff])(?=[\U00010900-\U00010A5F])|(?<=[\U00010900-\U00010A5F])(?=[\u0370-\u03ff])")

# Greek letters that only appear in Greek; OCRE's Latin letter forms (Ϥ for V, Λ for L, Ʈ for T)
# are excluded, so a Latin legend written with them is not mistaken for Greek.
_GREEK_ONLY = re.compile(r"[Ͱ-Ͽἀ-῿]")
_OCRE_LATIN_FORMS = set("ϤΛƮ")

ROMAN = {
    "Α": "A", "Β": "B", "Γ": "G", "Δ": "D", "Ε": "E", "Ζ": "Z", "Η": "E", "Θ": "TH", "Ι": "I",
    "Κ": "K", "Λ": "L", "Μ": "M", "Ν": "N", "Ξ": "X", "Ο": "O", "Π": "P", "Ρ": "R", "Σ": "S",
    "Τ": "T", "Υ": "Y", "Φ": "PH", "Χ": "CH", "Ψ": "PS", "Ω": "O", "Ϙ": "Q", "Ϝ": "W",
}
_DIPHTHONG_U = re.compile(r"(?<=[ΑΕΟΗ])Υ")      # ΟΥ -> OU, ΑΥ -> AU, ΕΥ -> EU


def is_greek(text: str) -> bool:
    """True if the text has a Greek letter that is not one of OCRE's Latin letter forms."""
    return any(_GREEK_ONLY.match(ch) and ch not in _OCRE_LATIN_FORMS for ch in text)


def strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return unicodedata.normalize("NFC", "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn"))


def fold(text: str) -> str:
    """Uppercase Greek, no accents, Latin look-alikes and letter variants mapped to Greek;
    cataloguers' notes dropped and other scripts split off as separate words."""
    text = _ALTERNATIVE.sub("", strip_accents(text))      # 'ΒΑΣΙ or ΒΑΣΙΛ': keep the first reading
    text = _NOTE_WORDS.sub(" ", text)
    text = "".join(LOOKALIKE.get(ch, ch) for ch in text)
    text = text.upper()          # after the map: lowercase ς and ϲ are handled there
    text = "".join(LOOKALIKE.get(ch, ch) for ch in text)
    for wrong, right in SPELLINGS.items():
        text = text.replace(wrong, right)
    return _SCRIPT_JOIN.sub(" ", text)


def romanise(greek: str) -> str:
    """'ΒΑΣΙΛΕΩΣ ΑΝΤΙΟΧΟΥ' -> 'BASILEOS ANTIOCHOU'. Expects folded text."""
    text = _DIPHTHONG_U.sub("U", greek)
    return "".join(ROMAN.get(ch, ch) for ch in text)
