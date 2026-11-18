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
    "Ϲ": "Σ", "ϲ": "Σ", "Ϛ": "ΣΤ", "Є": "Ε", "∈": "Ε", "Ɛ": "Ε", "ϵ": "Ε", "ς": "Σ",
    "Ϳ": "Ι", "Ꞷ": "Ω", "W": "Ω",
}

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
    """Uppercase Greek, no accents, Latin look-alikes and letter variants mapped to Greek."""
    text = strip_accents(text)
    text = "".join(LOOKALIKE.get(ch, ch) for ch in text)
    text = text.upper()          # after the map: lowercase ς and ϲ are handled there
    return "".join(LOOKALIKE.get(ch, ch) for ch in text)


def romanise(greek: str) -> str:
    """'ΒΑΣΙΛΕΩΣ ΑΝΤΙΟΧΟΥ' -> 'BASILEOS ANTIOCHOU'. Expects folded text."""
    text = _DIPHTHONG_U.sub("U", greek)
    return "".join(ROMAN.get(ch, ch) for ch in text)
