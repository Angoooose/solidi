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
    person: str | None = None  # the type's ruler this name or epithet refers to (Greek legends)


# OCRE's own editorial markers inside legend text: not words on the coin.
MARKERS = {
    "OR": {"latin": "or", "english": "or (variant reading)", "kind": "marker"},
    "VNCLEAR LEGEND": {"latin": "legend unclear", "english": "legend unclear", "kind": "marker"},
}


class Dictionary:
    def __init__(self, data: dict):
        self.data = data
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

    def with_overlay(self, overlay: dict) -> "Dictionary":
        """A copy with `overlay` laid over it: its entries replace ours, `null` removes one."""
        merged = {}
        for part in ("phrases", "words"):
            entries = dict(self.data.get(part) or {})
            for key, entry in (overlay.get(part) or {}).items():
                if entry is None:
                    entries.pop(key, None)
                else:
                    entries[key] = entry
            merged[part] = entries
        return Dictionary(merged)

    def lookup(self, tokens: list[str], i: int) -> tuple[int, dict | None]:
        for size in range(min(self.max_phrase, len(tokens) - i), 1, -1):
            entry = self.phrases.get(tuple(tokens[i:i + size]))
            if entry:
                return size, entry
        return 1, self.lookup_word(tokens[i])


PRAENOMINA = {
    "A": "Aulus", "AP": "Appius", "C": "Gaius", "CN": "Gnaeus", "D": "Decimus", "K": "Kaeso",
    "L": "Lucius", "M": "Marcus", "MN": "Manius", "N": "Numerius", "P": "Publius", "Q": "Quintus",
    "SER": "Servius", "SEX": "Sextus", "S": "Spurius", "SP": "Spurius", "T": "Titus", "TI": "Tiberius",
    "V": "Vibius",
}


PRAENOMINA_GENITIVE = {
    "A": "Auli", "AP": "Appi", "C": "Gai", "CN": "Gnaei", "D": "Decimi", "K": "Kaesonis",
    "L": "Luci", "M": "Marci", "MN": "Mani", "N": "Numeri", "P": "Publi", "Q": "Quinti",
    "SER": "Servi", "SEX": "Sexti", "S": "Spuri", "SP": "Spuri", "T": "Titi", "TI": "Tiberi",
    "V": "Vibi",
}

# Dictionary words a moneyer's own name may override on Republican coins (MAT = Matienus,
# TER = Terentius), and the kinds it may not: formulas, gods and virtues mean what they say.
_PROTECTED_KINDS = {"formula", "deity", "personification", "virtue", "numeral", "marker"}


def _legend_form(word: str) -> str:
    return word.upper().replace("U", "V").replace("J", "I")


def apply_names(segments: list[Segment], names: list[str], dictionary: Dictionary | None = None,
                override: bool = False) -> list[Segment]:
    """Gloss words the dictionary doesn't know from the names of the type's own issuers.

    Republican moneyers sign with their own names, abbreviated at will: for a type issued by
    'C. Aburius Geminus', C ABVRI is 'Gaius Aburius' and GEM is 'Geminus'. A word matches when it
    is a name word or the start of one (3+ letters); a 1-2 letter word matches the issuer's own
    praenomen ('Cn.' -> CN). Only unknown words are touched, so the dictionary always wins,
    except with `override` (Republican coins): there a single dictionary word that is not a
    formula, god, virtue or numbered title gives way to the issuer's name (MAT = Matienus).
    """
    words: dict[str, str] = {}
    praenomina: set[str] = set()
    for name in names:
        # Nomisma marks restored letters and inferred names: 'Ogul[nius]', '(Furius) Purpurio'.
        for w in re.sub(r"[\[\]()]", "", name).replace(",", " ").split():
            if w.endswith(".") and _legend_form(w[:-1]) in PRAENOMINA:
                praenomina.add(_legend_form(w[:-1]))
            elif w[:1].isupper() and len(w) > 2:
                words.setdefault(_legend_form(w), w)
    for seg in segments:
        if seg.kind != "unknown":
            entry = dictionary.lookup_word(seg.text) if (override and dictionary and " " not in seg.text) else None
            if not (entry and seg.kind not in _PROTECTED_KINDS and not entry.get("numbered")
                    and seg.number is None):
                continue
            if seg.text in praenomina or len(seg.text) < 3:
                continue
        t = seg.text
        if t in praenomina:
            seg.latin = seg.english = PRAENOMINA[t]
            seg.kind = "name"
            continue
        # Archaic spellings (SERVEILI, MAXSVMVS) and the genitive -I of -IVS names (PAETI: Paetus).
        modern = t.replace("EI", "I").replace("XS", "X")
        forms = {t, modern} | ({modern[:-1]} if modern.endswith("I") and len(modern) >= 5 else set())
        match = next((w for f, w in words.items() for v in forms
                      if f == v or (len(v) >= 3 and f.startswith(v))), None)
        if not match:
            continue
        seg.latin = seg.english = match
        seg.kind = "name"
    return segments


def _praenomen(seg: Segment | None) -> bool:
    return bool(seg) and seg.kind == "name" and seg.text in PRAENOMINA


def apply_filiation(segments: list[Segment]) -> list[Segment]:
    """C F after a name is 'son of Gaius', not 'Gaius · son'; CN N 'grandson of Gnaeus'.
    (C EGNATIVS CN F CN N = Gaius Egnatius, son of Gnaeus, grandson of Gnaeus.)"""
    out: list[Segment] = []
    i = 0
    while i < len(segments):
        seg, nxt = segments[i], segments[i + 1] if i + 1 < len(segments) else None
        prev = out[-1] if out else None
        if (_praenomen(seg) and nxt and nxt.text in ("F", "N") and prev
                and prev.kind in ("name", "unknown", "filiation")):
            rel = ("filius", "son of") if nxt.text == "F" else ("nepos", "grandson of")
            out.append(Segment(f"{seg.text} {nxt.text}", f"{PRAENOMINA_GENITIVE[seg.text]} {rel[0]}",
                               f"{rel[1]} {PRAENOMINA[seg.text]}", "filiation"))
            i += 2
            continue
        out.append(seg)
        i += 1
    return out


def apply_legion(segments: list[Segment]) -> list[Segment]:
    """LEG is a legion only before its number (LEG VI, LEG I MIN); otherwise a legate
    (P CARISIVS LEG AVGVSTI). A lone I, V or X after LEG is the legion's number."""
    for i, seg in enumerate(segments):
        if seg.text != "LEG":
            continue
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        if nxt and nxt.kind == "unknown" and nxt.text in ("I", "V", "X"):
            n = roman_value(nxt.text)
            nxt.latin, nxt.english, nxt.kind, nxt.number = nxt.text, str(n), "numeral", n
        if not (nxt and nxt.kind == "numeral"):
            seg.latin, seg.english, seg.kind = "Legatus", "legate", "office"
    return segments


_QUAESTOR_BEFORE = {"S C", "EX S C", "DESIG", "DES", "D", "P", "PRO", "VRB", "PRO COS", "PRO PR"}


def apply_republic(segments: list[Segment]) -> list[Segment]:
    """Republican readings no single dictionary entry can give.

    - Q after a name is quaestor (NERI Q VRB, Q LVTATI Q); after another praenomen it is a
      nomen we can't expand (T Q, TI Q) and stays unknown; before a name it is Quintus.
    - Runs of three or more single letters are initialisms of formulas (L P D A P), not
      praenomina: unless a phrase caught them, they stay unknown.
    """
    for i, seg in enumerate(segments):
        if seg.text != "Q" or seg.kind != "name":
            continue
        prev = segments[i - 1] if i else None
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        if _praenomen(prev):
            seg.latin = seg.english = None
            seg.kind = "unknown"
        elif prev and (nxt is None or nxt.text in _QUAESTOR_BEFORE or nxt.kind in ("office", "formula")):
            seg.latin, seg.english, seg.kind = "Quaestor", "quaestor", "office"
    run: list[Segment] = []
    for seg in [*segments, None]:
        if seg is not None and len(seg.text) == 1 and seg.kind in ("name", "unknown", "word"):
            run.append(seg)
            continue
        if len(run) >= 3:
            for r in run:
                r.latin = r.english = None
                r.kind = "unknown"
        run = []
    return segments


def _base_name(english: str | None) -> str:
    """'and of Strato Philopator' -> 'strato'; 'of Alexander, son of Philip' -> 'alexander'."""
    text = (english or "").lower()
    for prefix in ("and of ", "of "):
        text = text.removeprefix(prefix)
    return text.split(",")[0].split(" ")[0] if text else ""


def _epithet_word(english: str | None) -> str:
    """'Soter (Saviour)' -> 'soter': the epithet as it appears in rulers' names."""
    return (english or "").split(" (")[0].split(" ")[0].lower()


def apply_greek(segments: list[Segment], dictionary: Dictionary,
                persons: list[tuple[str, str]] | None = None, truncations: bool = True) -> list[Segment]:
    """Greek and Gandhari royal legends.

    - Truncated words (ΑΛΕΞ, ΑΝΤΙΟΧ) read as the dictionary word they begin, if all candidates
      agree or exactly one names the type's ruler (`truncations`: Hellenistic corpora only).
    - A legend that opens with a genitive name reads '(coin) of …'; ΒΑΣΙΛΕΩΣ after the name
      is then 'King' (ΠΤΟΛΕΜΑΙΟΥ ΒΑΣΙΛΕΩΣ = of Ptolemy, King).
    - Names link to the type's own rulers, and epithets to the name they qualify, before or
      after it (ΒΑΣΙΛΕΩΣ ΣΩΤΗΡΟΣ ΜΕΝΑΝΔΡΟΥ). `persons` is (id, name), stated authority first:
      the ruler named on the coin, then authority, issuer, portrait. A ruler whose name holds
      the legend's epithet wins (ΠΤΟΛΕΜΑΙΟΥ ΣΩΤΗΡΟΣ = Ptolemy I Soter), and a name repeated in
      one legend takes the next ruler of that name (Strato II and his grandson Strato III).
    """
    persons = persons or []
    rulers = [name.lower() for _, name in persons]
    if truncations:
        for seg in segments:
            if seg.kind != "unknown" or len(seg.text) < 3 or not seg.text.isalpha():
                continue
            found = [e for k, e in dictionary.words.items() if k.startswith(seg.text) and k != seg.text]
            meanings = {e.get("english") for e in found}
            if len(meanings) > 1:
                found = [e for e in found if e.get("kind") == "name"
                         and any(_base_name(e.get("english")) in r.split() for r in rulers)]
                meanings = {e.get("english") for e in found}
            if len(meanings) == 1:
                e = found[0]
                seg.latin, seg.english, seg.kind = e.get("full"), e.get("english"), e.get("kind", "word")
                seg.number = None

    if segments and segments[0].kind == "name":
        entry = dictionary.lookup_word(segments[0].text) or {}
        if not entry and segments[0].latin:      # a truncated name: genitive like its full form
            entry = {"case": "gen"}
        if entry.get("case") == "gen" and segments[0].english and not segments[0].english.startswith(("of ", "and ")):
            segments[0].english = f"of {segments[0].english}"
        nxt = segments[1] if len(segments) > 1 else None
        if nxt and nxt.kind == "title" and nxt.english in ("of King", "of Queen"):
            nxt.english = nxt.english.removeprefix("of ")

    # Groups: a name with the epithets around it, split at titles and at 'and'.
    groups: list[list[Segment]] = [[]]
    for seg in segments:
        if seg.kind == "title" or seg.english in ("and", "and of") or (seg.english or "").startswith("and of"):
            groups.append([])
        if seg.kind in ("name", "epithet"):
            groups[-1].append(seg)
    used: list[str] = []
    for group in groups:
        names = [g for g in group if g.kind == "name"]
        epithets = {_epithet_word(g.english) for g in group if g.kind == "epithet"}
        for name in names:
            base = _base_name(name.english)
            candidates = [(pid, n.lower()) for pid, n in persons if base and base in n.lower().replace(",", "").split()]
            if candidates:
                # The ruler whose name carries this legend's epithet, then one not yet used here.
                candidates.sort(key=lambda c: (not (epithets & set(c[1].split())), c[0] in used))
                name.person = candidates[0][0]
                used.append(name.person)
            else:
                entry = dictionary.lookup_word(name.text) or {}
                name.person = entry.get("default_person")
        # Epithets take the name after them if they come first, else the name before them.
        current = names[0].person if names else None
        for seg in group:
            if seg.kind == "name":
                current = seg.person
            else:
                seg.person = current
    return segments


def expand(normalised: str, dictionary: Dictionary, names: list[str] | None = None,
           republic: bool = False, lang: str = "la",
           persons: list[tuple[str, str]] | None = None, truncations: bool = True) -> list[Segment]:
    """`republic`: the coin was struck before 27 BC (pass the Republican dictionary too).
    `lang`: 'la', or 'grc'/'pgd' for Greek and Gandhari (transliterated) legends."""
    tokens = normalised.split()
    out: list[Segment] = []
    i = 0
    while i < len(tokens):
        size, entry = dictionary.lookup(tokens, i)
        if entry:
            # 'latin' in the Latin dictionary; 'full' (written-out Greek) in the others.
            seg = Segment(" ".join(tokens[i:i + size]), entry.get("latin") or entry.get("full"),
                          entry.get("english"), entry.get("kind", "word"))
            i += size
            numbered = entry.get("numbered")
            # III VIR is 'triumvir', not a third acclamation (C CAESAR IMP III VIR R P C).
            board = i + 1 < len(tokens) and tokens[i + 1] in ("VIR", "V")
            n = title_number(tokens[i]) if numbered and i < len(tokens) and not board else None
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
    if lang != "la":
        return apply_greek(out, dictionary, persons, truncations)
    if names:
        apply_names(out, names, dictionary, override=republic)
    out = apply_filiation(out)
    apply_legion(out)
    if republic:
        apply_republic(out)
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
                             and ((prev.latin or "").lower().endswith(("i", "is"))
                                  # read from an issuer's name: GORDIANI -> 'Gordian'
                                  or (prev.text.endswith("I") and not (prev.latin or "").upper().endswith("I"))))
            if prev and prev.kind == "name" and female(prev):
                seg.latin, seg.english = "Augusta", "empress"
            elif prev_word in _FILIATION:
                pass
            elif genitive_name or (nxt and nxt.text in ("F", "FIL")):
                seg.latin, seg.english = "Augusti", "of the Emperor"
            elif subject_female and seen_subject:
                seg.latin, seg.english = "Augusta", "empress"
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
