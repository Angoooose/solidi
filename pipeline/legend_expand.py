"""Expand normalised legends into glossed segments using data/legend_abbreviations.yaml.

'IMP TRAIANO AVG GER DAC P M TR P' ->
  IMP → Imperator → Emperor · TRAIANO → Traiano → Trajan · … · P M → Pontifex Maximus → chief priest · …

Deterministic: longest phrase first, then single words; a Roman numeral after a numbered title
attaches to it (COS V → 'consul for the 5th time'). Anything unmatched is kept as 'unknown',
so the original is never hidden or guessed at.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

# Coins use additive forms too: IIII, VIIII, XIIII, XXXX.
_ROMAN = re.compile(r"^(?=[MDCLXVI])M{0,4}(CM|CD|D?C{0,4})(XC|XL|L?X{0,4})(IX|IV|V?I{0,4})$")
_VALUES = {"M": 1000, "D": 500, "C": 100, "L": 50, "X": 10, "V": 5, "I": 1}


def roman_value(token: str) -> int | None:
    if not token or not _ROMAN.match(token):
        return None
    total = 0
    for i, ch in enumerate(token):
        v = _VALUES[ch]
        total += -v if i + 1 < len(token) and _VALUES[token[i + 1]] > v else v
    return total


def title_number(token: str) -> int | None:
    """A numeral that can follow a title (COS IIII, TR P XXXVII, IMP XXII). Letters such as
    M, L, C and D are usually first names there (IMP M IVL PHILIPPVS), so only I/V/X count,
    plus L inside a longer numeral (XL, LX)."""
    if token == "L" or not set(token) <= set("IVXL"):
        return None
    return roman_value(token)


def free_number(token: str) -> int | None:
    """A free-standing numeral (VOT XX, MVLT XXX). I/V/X only and more than one letter:
    single letters and words like DIV, MI or CL are abbreviations, not numbers."""
    if len(token) < 2 or not set(token) <= set("IVX"):
        return None
    return roman_value(token)


def ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


NUMBERED_GLOSS = {
    "times": lambda e, n: f"{e} for the {ordinal(n)} time",
    "year": lambda e, n: f"{e} ({ordinal(n)} year)",
    "acclamation": lambda e, n: f"{e} ({ordinal(n)} acclamation)",
}


@dataclass
class Segment:
    text: str                 # as on the coin (normalised)
    latin: str | None
    english: str | None
    kind: str                 # dictionary kind, 'numeral' or 'unknown'
    number: int | None = None


# OCRE's own editorial markers inside legend text: not words on the coin.
MARKERS = {
    "OR": {"latin": "or", "english": "or (variant reading)", "kind": "marker"},
    "VNCLEAR LEGEND": {"latin": "legend unclear", "english": "legend unclear", "kind": "marker"},
}


class Dictionary:
    def __init__(self, data: dict):
        self.phrases = {tuple(k.split()): v for k, v in (data.get("phrases") or {}).items()}
        for key, entry in MARKERS.items():
            self.phrases.setdefault(tuple(key.split()), entry)
        self.words = data.get("words") or {}
        self.max_phrase = max((len(k) for k in self.phrases), default=1)

    def lookup_word(self, token: str) -> dict | None:
        return self.words.get(token) or self.phrases.get((token,))

    @classmethod
    def load(cls, path: Path) -> "Dictionary":
        return cls(yaml.safe_load(path.read_text(encoding="utf-8")) or {})

    def lookup(self, tokens: list[str], i: int) -> tuple[int, dict | None]:
        for size in range(min(self.max_phrase, len(tokens) - i), 1, -1):
            entry = self.phrases.get(tuple(tokens[i:i + size]))
            if entry:
                return size, entry
        return 1, self.lookup_word(tokens[i])


def expand(normalised: str, dictionary: Dictionary) -> list[Segment]:
    tokens = normalised.split()
    out: list[Segment] = []
    i = 0
    while i < len(tokens):
        size, entry = dictionary.lookup(tokens, i)
        if entry:
            seg = Segment(" ".join(tokens[i:i + size]), entry.get("latin"), entry.get("english"),
                          entry.get("kind", "word"))
            i += size
            numbered = entry.get("numbered")
            n = title_number(tokens[i]) if numbered and i < len(tokens) else None
            if n:
                seg.text += f" {tokens[i]}"
                seg.latin = f"{seg.latin} {tokens[i]}"
                seg.english = NUMBERED_GLOSS[numbered](seg.english, n)
                seg.number = n
                i += 1
            out.append(seg)
        elif n := free_number(tokens[i]):
            out.append(Segment(tokens[i], tokens[i], str(n), "numeral", n))
            i += 1
        else:
            out.append(Segment(tokens[i], None, None, "unknown"))
            i += 1
    return apply_context(out, dictionary)


# Abbreviations whose case or gender depends on context.
_AVG_FORMS = {"AVG", "AVGVS", "AVGVST"}
_GENITIVE_AFTER = {"personification", "virtue", "deity", "word"}
_FILIATION = {"F", "FIL", "NEP", "N", "PRON"}          # 'son of', 'grandson of': AVG after these is the subject's own title
_MALE_SUBJECT_START = {"IMP", "CAES", "CAESAR", "IMP CAES", "IMP C"}
FEMININE = {
    "D N": ("Domina Nostra", "our Lady"),
    "P F AVG": ("Pia Felix Augusta", "dutiful and fortunate Augusta"),
    "P F": ("Pia Felix", "dutiful and fortunate"),
    "AEL": ("Aelia", "Aelia"),
    "FL": ("Flavia", "Flavia"),
    "FLAV": ("Flavia", "Flavia"),
    "FIL": ("Filia", "daughter"),
    "F": ("Filia", "daughter"),
}


_NAME_PREFIXES = {"AEL", "FL", "FLAV"}        # Aelia/Aelius, Flavia/Flavius: gender comes from the next name


def apply_context(segments: list[Segment], dictionary: Dictionary) -> list[Segment]:
    """Gender and case that a dictionary entry alone cannot know.

    - The subject is the first real name (AEL/FL are skipped: their gender follows the name).
      If she is a woman, D N, P F AVG, AEL, FL, F and AVG after her name take feminine forms
      (D N GALLA PLACIDIA P F AVG = Our Lady Galla Placidia, dutiful and fortunate Augusta), until
      a man's titles start (DOMITIAE AVG IMP CAES DIVI F … = Domitian's titles). Titles before any
      name are never feminised (CAES AVG … MATIDIA AVG: the first AVG is Trajan's).
    - AVG straight after a woman's name is Augusta, whoever the subject is (… IVLIA MAMAEA AVG).
    - AVG after a genitive name (GERMANICI, PII) or a virtue (VICTORIA AVG) = Augusti;
      AVG right before F/FIL (CAESAR AVG F) = Augusti too: 'son of the Emperor'.
    - AVG after F/FIL/NEP stays the subject's own title (DIVI VESP F AVG = son of Vespasian, Augustus).
    - AVGVSTA after a virtue or personification is the adjective (SPES AVGVSTA = imperial Hope).
    Gender comes only from `gender: f` in the dictionary.
    """
    def female(seg: Segment) -> bool:
        if seg.text in ("DIVA", "DIVAE"):
            return True
        entry = dictionary.lookup_word(seg.text) if " " not in seg.text else None
        return bool(entry and entry.get("gender") == "f")

    names = [s for s in segments if (s.kind == "name" and s.text not in _NAME_PREFIXES)
             or s.text in ("DIVA", "DIVAE")]
    subject_female = bool(names) and female(names[0])
    seen_subject = False
    for i, seg in enumerate(segments):
        prev = segments[i - 1] if i else None
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        if seg in names:
            seen_subject = True
        elif seen_subject and seg.text in _MALE_SUBJECT_START:
            subject_female = False

        if seg.text in _AVG_FORMS:
            prev_word = prev.text.split()[-1] if prev else ""
            genitive_name = (prev and prev.kind == "name" and not female(prev)
                             and (prev.latin or "").lower().endswith(("i", "is")))
            if prev and prev.kind == "name" and female(prev):
                seg.latin, seg.english = "Augusta", "Augusta (empress)"
            elif prev_word in _FILIATION:
                pass
            elif genitive_name or (nxt and nxt.text in ("F", "FIL")):
                seg.latin, seg.english = "Augusti", "of the Emperor"
            elif subject_female and seen_subject:
                seg.latin, seg.english = "Augusta", "Augusta (empress)"
            elif prev and prev.kind in _GENITIVE_AFTER:
                seg.latin, seg.english = "Augusti", "of the Emperor"
        elif seg.text in ("AVGVSTA", "AVGVSTAE") and prev and prev.kind in ("personification", "virtue"):
            seg.latin, seg.english = {"AVGVSTA": "Augusta", "AVGVSTAE": "Augustae"}[seg.text], "imperial"
        elif subject_female and seg.text in FEMININE:
            if seg.text == "F" and not (prev and prev.kind in ("name", "title")):
                continue
            seg.latin, seg.english = FEMININE[seg.text]
    return segments


def coverage(segments: list[Segment]) -> float:
    words = sum(len(s.text.split()) for s in segments)
    known = sum(len(s.text.split()) for s in segments if s.kind != "unknown")
    return known / words if words else 0.0


def as_rows(segments: list[Segment]) -> list[dict]:
    return [{k: v for k, v in asdict(s).items() if v is not None} for s in segments]
