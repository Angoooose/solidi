"""Scripts other than Latin and Greek on coin legends, and their romanisation.

Indo-Greek coins are bilingual: Greek on the obverse, Gandhari Prakrit in Kharoshthi on the
reverse ('𐨨𐨱𐨪𐨗𐨯 𐨟𐨿𐨪𐨟𐨪𐨯 𐨨𐨅𐨣𐨡𐨿𐨪𐨯' = maharajasa tratarasa menadrasa, 'of the great king,
the saviour, Menander'). A few Seleucid and Indo-Greek coins carry Phoenician or Brahmi.
Collectors know the Kharoshthi legends by their transliteration, so that is what search uses.
"""

from __future__ import annotations

import unicodedata

# Script ranges -> language code for the legend (ISO 639-3 where one exists).
SCRIPTS = [
    (0x10A00, 0x10A5F, "pgd"),     # Kharoshthi: Gandhari
    (0x11000, 0x1107F, "pra"),     # Brahmi: Prakrit
    (0x10900, 0x1091F, "phn"),     # Phoenician
]


def script_language(text: str) -> str | None:
    for ch in text:
        cp = ord(ch)
        for lo, hi, lang in SCRIPTS:
            if lo <= cp <= hi:
                return lang
    return None


def clean(text: str) -> str:
    """Drop invisible format characters (bidi marks around Phoenician) and collapse spaces."""
    return " ".join("".join(ch for ch in text if unicodedata.category(ch) != "Cf").split())


# Kharoshthi is an abugida: a consonant carries an inherent 'a', replaced by a vowel sign or
# removed by the virama. Simplified ASCII transliteration (no diacritics), as collectors type it.
_KH_CONSONANTS = {                                   # Unicode Kharoshthi block, U+10A10-10A35
    0x10A10: "k", 0x10A11: "kh", 0x10A12: "g", 0x10A13: "gh", 0x10A15: "c", 0x10A16: "ch",
    0x10A17: "j", 0x10A19: "ny", 0x10A1A: "t", 0x10A1B: "th", 0x10A1C: "d", 0x10A1D: "dh",
    0x10A1E: "n", 0x10A1F: "t", 0x10A20: "th", 0x10A21: "d", 0x10A22: "dh", 0x10A23: "n",
    0x10A24: "p", 0x10A25: "ph", 0x10A26: "b", 0x10A27: "bh", 0x10A28: "m", 0x10A29: "y",
    0x10A2A: "r", 0x10A2B: "l", 0x10A2C: "v", 0x10A2D: "sh", 0x10A2E: "s", 0x10A2F: "s",
    0x10A30: "z", 0x10A31: "h", 0x10A32: "k", 0x10A33: "th", 0x10A34: "t", 0x10A35: "vh",
}
_KH_VOWEL_SIGNS = {0x10A01: "i", 0x10A02: "u", 0x10A03: "ri", 0x10A05: "e", 0x10A06: "o"}
_KH_MODIFIERS = {0x10A0E: "m", 0x10A0F: "h"}        # anusvara, visarga
_KH_VIRAMA = 0x10A3F
_KH_VOWEL_A = 0x10A00                                # independent vowel: a carrier for vowel signs


def romanise_kharoshthi(text: str) -> str:
    """'𐨨𐨱𐨪𐨗𐨯' -> 'maharajasa'; '𐨀𐨤𐨫𐨡𐨟𐨯' -> 'apaladatasa'."""
    out: list[str] = []
    inherent = False                  # the last consonant still carries its inherent 'a'
    for ch in text:
        cp = ord(ch)
        if cp in _KH_CONSONANTS or cp == _KH_VOWEL_A:
            if inherent:
                out.append("a")
            out.append(_KH_CONSONANTS.get(cp, ""))
            inherent = True
        elif cp in _KH_VOWEL_SIGNS:
            out.append(_KH_VOWEL_SIGNS[cp])
            inherent = False
        elif cp == _KH_VIRAMA:
            inherent = False
        elif cp in _KH_MODIFIERS:
            if inherent:
                out.append("a")
                inherent = False
            out.append(_KH_MODIFIERS[cp])
        elif 0x10A00 <= cp <= 0x10A5F:
            continue                  # length marks, dots and other diacritics
        else:
            if inherent:
                out.append("a")
                inherent = False
            out.append(ch)
    if inherent:
        out.append("a")
    return "".join(out)
