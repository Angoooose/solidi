"""Legend normalisation and fragment search.

OCRE writes legends diplomatically: '-' and '_' mark line breaks inside words, '/' and '//'
separate fields, [ ] mark restored letters, dots divide words, (lowercase notes) are editorial,
and a few special letters stand for Latin ones (Ꜹ = AV, ∈ = E, Ϥ = V). Collectors type legends
with inconsistent spacing, so search compares a space-free 'compact' form.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import yaml

from pipeline import greek, scripts
from pipeline.legend_expand import Dictionary, apply_context_names, as_rows, coverage, expand

LETTER_MAP = {
    "Ꜹ": "AV", "∈": "E", "Ϥ": "V", "Ʈ": "T", "Λ": "L",
    "U": "V", "J": "I",
}
_EDITORIAL = re.compile(r"\([^)]*[a-z.][^)]*\)")      # '(rev.N)' and similar notes
_WORD_BREAK = re.compile(r"(?<=[\w\]])[-_](?=[\w\[])")   # HONORI-VS -> HONORIVS, NOS-[TRIS] -> NOS[TRIS]
_SEPARATORS = re.compile(r"[\s\-_/|•·˙.:●*,;?…()←' ]+")
GAP = re.compile(r"\s*(?:\.\.\.+|…|\*)\s*")             # what a user types for unreadable stretches


_LOOKALIKE_ONLY = re.compile(r"^[ABEZHIKMNOPTYXCVW\s\W\d]+$")
_PROSE = re.compile(r"[a-z]{3,}")


_LATIN_ONLY = set("DFGJLQRSUVW")       # Latin capitals with no Greek look-alike


def _mostly_latin(text: str) -> bool:
    """Late Roman legends end in a Greek workshop numeral (CONCORDIA AVGGGθ, VICTORIA AVGGGΓ):
    Latin with a Greek letter, not Greek."""
    latin = sum(ch in _LATIN_ONLY for ch in text)
    greek_letters = sum(greek.is_greek(ch) for ch in text)
    return latin > 2 * greek_letters


def language(legend: str, default: str = "la") -> str:
    """The legend's language, by script: 'grc' Greek, 'pgd' Gandhari (Kharoshthi), 'pra'
    Prakrit (Brahmi), 'phn' Phoenician, 'la' Latin. In a Greek corpus, text in Latin look-alike
    capitals is Greek (ANTIOX), and lowercase prose is a cataloguer's note, not a legend
    ('Illegible inscription', 'anepigraphic'): 'zxx', kept but not searched or glossed."""
    text = _EDITORIAL.sub("", legend)
    if greek.is_greek(text) and not _mostly_latin(text):
        return "grc"          # bilingual Greek-Phoenician legends (Tyre, Sidon) count as Greek
    if lang := scripts.script_language(text):
        return lang
    if default == "grc":
        if _PROSE.search(text):
            return "zxx"
        if _LOOKALIKE_ONLY.match(text):
            return "grc"
    return "la"


# Letters resolved inside a word, CN-style: ΚΑΙ(Σ), ΦΙΛΙΠΠΟΠΟΛ(Ε)ΙΤΩΝ, C(A)ES; with alternatives,
# ΝΕΩΚΟΡ(Ω,Ο)Υ, the first. Ligatures marked inside a word: ΑΝΤΩ*ΝΕ*ΙΝΟΣ.
_INWORD_PARENS = re.compile(r"(?<=[^\W\d_])\(([^()\s,;]+)(?:[,;][^()]*)?\)|\(([^()\s,;]+)(?:[,;][^()]*)?\)(?=[^\W\d_])")
_INWORD_STAR = re.compile(r"(?<=[^\W\d_])\*(?=[^\W\d_])|(?<=\s)\*(?=[^\W\d_]+\*)|(?<=[^\W\d_])\*(?=\s|$)")


def normalise(legend: str, lang: str = "la") -> str:
    """'D N HONORI-VS•P•F•AVG' -> 'D N HONORIVS P F AVG'; Greek: 'BAΣΙΛΕΩΣ ANTIOXOY' -> 'ΒΑΣΙΛΕΩΣ ΑΝΤΙΟΧΟΥ'."""
    text = _EDITORIAL.sub("", legend)
    if lang != "zxx":
        text = _INWORD_PARENS.sub(lambda m: m.group(1) or m.group(2), text)
        text = _INWORD_STAR.sub("", text)
    if lang == "zxx":
        return " ".join(text.split())
    if lang in ("pgd", "pra", "phn", "xlc", "xcr"):
        text = scripts.clean(text)
    elif lang == "grc":
        text = greek.fold(scripts.clean(text))
    else:
        text = "".join(LETTER_MAP.get(ch, ch) for ch in text.upper())
    text = _WORD_BREAK.sub("", text)
    text = re.sub(r"[\[\]]", "", text)                     # restored letters belong to the word
    text = _SEPARATORS.sub(" ", text)
    text = text.replace("�", "")                    # broken characters in the source
    return " ".join(text.split())


def compact(legend: str, lang: str = "la") -> str:
    return normalise(legend, lang).replace(" ", "")


def transliterate(normalised: str, lang: str) -> str | None:
    """Readable Latin-letter form for display: 'basileos antiochou', 'maharajasa tratarasa menadrasa'."""
    if lang == "grc":
        # Bilingual legends: transliterate the Greek, leave the other script out.
        greek_only = "".join(ch for ch in normalised if not scripts.script_language(ch))
        return " ".join(greek.romanise(greek_only).lower().split())
    if lang == "pgd":
        return scripts.romanise_kharoshthi(normalised)
    if lang == "xlc":
        return scripts.romanise_lycian(normalised)
    return None


def romanised(normalised: str, lang: str = "grc") -> str | None:
    """Space-free Latin-letter form, normalised as Latin legends are so one query matches all.
    Greek and Kharoshthi are transliterated; Latin needs none; other scripts have none yet."""
    if lang == "grc":
        return compact(greek.romanise(normalised))
    if lang == "pgd":
        return compact(scripts.romanise_kharoshthi(normalised))
    if lang == "xlc":
        return compact(scripts.romanise_lycian(normalised, ascii_only=True))
    return None


# Where on the side each part of a legend sits. OCRE splits fields with '//' and notes the place
# after a part: 'SALVS AVGVSTI // COS III (in exergue) // S C (in field)'. PCO and SCO write 'l.'
# and 'r.' after each word: 'ΠΤΟΛΕΜΑΙΟΥ on l., ΒΑΣΙΛΕΩΣ on r.'.
_PLACE_NOTE = re.compile(r"\(\s*in (exergue or field|exergue|field)\s*\)\s*$")
_LEFT_RIGHT = re.compile(r"\s*(.+?)\s+(?:on\s+)?([lr])\.,?(?=\s|$)")
PLACE_NAMES = {"exergue": "exergue", "field": "field", "exergue or field": "exergue or field",
               "l": "left field", "r": "right field"}


def places(legend: str) -> list[tuple[str | None, str]]:
    """The legend's parts in order, each with its place on the side ('exergue', 'left field'), or
    None where the source doesn't say. A single part with no place is [(None, legend)]."""
    text = legend.strip()
    if "//" in text:
        parts = []
        for part in text.split("//"):
            part = part.strip()
            if not part:
                continue
            note = _PLACE_NOTE.search(part)
            parts.append((PLACE_NAMES[note.group(1)] if note else None, part[:note.start()].strip() if note else part))
        # The first part runs around the edge when the others are placed.
        if len(parts) > 1 and parts[0][0] is None and any(p for p, _ in parts[1:]):
            parts[0] = ("around", parts[0][1])
        return parts or [(None, text)]
    lr = list(_LEFT_RIGHT.finditer(text))
    if lr and "".join(m.group(0) for m in lr).strip() == text:
        return [(PLACE_NAMES[m.group(2)], m.group(1)) for m in lr]
    return [(None, text)]


def _place_segments(rows: list[dict], legend: str, lang: str) -> None:
    """Mark each segment with its part's place, matching words in order. Left alone where the
    parts' words don't line up with the segments' (a segment spanning two parts, say)."""
    parts = places(legend)
    if all(p is None for p, _ in parts):
        return
    bounds, total = [], 0
    for place, part in parts:
        total += len(normalise(part, lang).split())
        bounds.append((total, place))
    if total != sum(len(r["text"].split()) for r in rows):
        return
    marks, seen, i = [], 0, 0
    for r in rows:
        while i < len(bounds) - 1 and seen >= bounds[i][0]:
            i += 1
        start = seen
        seen += len(r["text"].split())
        if seen > bounds[i][0] and start < bounds[i][0]:
            return                       # straddles two parts
        marks.append(bounds[i][1])
    for r, place in zip(rows, marks):
        if place:
            r["place"] = place


def build_index(db: sqlite3.Connection, dictionary: "Dictionary | None" = None,
                languages: dict[str, str] | None = None) -> int:
    """`languages`: each dataset slug's main legend language (sources.yaml `legend_language`)."""
    languages = languages or {}
    # Issuer names gloss moneyers' signatures the dictionary can't know (C ABVRI = Gaius Aburius).
    republic = None
    if dictionary:
        overlay = Path(__file__).resolve().parent.parent / "data" / "legend_abbreviations_republic.yaml"
        republic = dictionary.with_overlay(yaml.safe_load(overlay.read_text(encoding="utf-8")) or {})
    data = Path(__file__).resolve().parent.parent / "data"
    others = {lang: Dictionary.load(data / f"legend_{name}.yaml")
              for lang, name in (("grc", "greek"), ("pgd", "gandhari")) if (data / f"legend_{name}.yaml").exists()}
    # Greek legends of the Roman Empire (after 31 BC): emperors' titles in Greek, read by date.
    greek_imperial = None
    if "grc" in others and (data / "legend_greek_imperial.yaml").exists():
        greek_imperial = others["grc"].with_overlay(
            yaml.safe_load((data / "legend_greek_imperial.yaml").read_text(encoding="utf-8")) or {})
    names: dict[str, list[str]] = {}
    persons: dict[str, list[tuple[str, str]]] = {}
    authority: dict[str, str] = {}
    for type_id, pid, name, role in db.execute(
            """SELECT tp.type_id, p.id, p.name, tp.role FROM type_person tp JOIN person p ON p.id = tp.person_id
               ORDER BY tp.type_id, CASE tp.role WHEN 'stated_authority' THEN 0 WHEN 'authority' THEN 1
                                    WHEN 'issuer' THEN 2 ELSE 3 END, p.id"""):
        if role in ("issuer", "authority", "stated_authority"):
            names.setdefault(type_id, []).append(name)
        if role in ("authority", "stated_authority"):
            authority.setdefault(type_id, pid)
        persons.setdefault(type_id, []).append((pid, name))
    # The type's mint (and its city, for a workshop) and regions: civic legends name them.
    places: dict[str, list[str]] = {}
    for type_id, name in db.execute(
            """SELECT t.id, m.name FROM coin_type t JOIN mint m ON m.id = t.mint_id
               UNION SELECT t.id, pm.name FROM coin_type t JOIN mint m ON m.id = t.mint_id JOIN mint pm ON pm.id = m.parent_id
               UNION SELECT t.id, r.name FROM coin_type t JOIN mint m ON m.id = t.mint_id JOIN region r ON r.id = m.region_id
               UNION SELECT tr.type_id, r.name FROM type_region tr JOIN region r ON r.id = tr.region_id"""):
        places.setdefault(type_id, []).append(name)
    romanisers = {"grc": greek.romanise, "pgd": lambda w: w,
                  "xlc": lambda w: scripts.romanise_lycian(w, ascii_only=True)}
    rows = []
    # Coins struck before 27 BC, when Octavian became Augustus, are read with Republican senses.
    for type_id, obv, rev, year, start, slug in db.execute(
            """SELECT t.id, t.obv_legend, t.rev_legend, COALESCE(t.end_year, t.start_year),
                      COALESCE(t.start_year, t.end_year), d.slug
               FROM coin_type t JOIN dataset d ON d.id = t.dataset_id"""):
        early = year is not None and year < -27
        imperial = start is not None and start >= -31
        for side, legend in (("obverse", obv), ("reverse", rev)):
            legend = scripts.clean(legend) if legend else legend     # stray bidi marks (SCO Phoenician)
            lang = language(legend, languages.get(slug, "la")) if legend else "la"
            if legend and (norm := normalise(legend, lang)):
                latin = english = segments = cov = None
                segs = None
                if dictionary and lang == "la":
                    segs = expand(norm, republic if early else dictionary, names.get(type_id), early)
                elif lang in others or lang == "xlc":
                    # Gandhari and Lycian are glossed from their transliteration.
                    text = transliterate(norm, lang) if lang in ("pgd", "xlc") else norm
                    d = greek_imperial if (lang == "grc" and imperial and greek_imperial) else others.get(lang, Dictionary({}))
                    segs = expand(text, d, lang=lang, persons=persons.get(type_id),
                                  truncations=languages.get(slug) == "grc", authority=authority.get(type_id))
                    apply_context_names(segs, romanisers[lang], persons.get(type_id), places.get(type_id))
                if segs:
                    seg_rows = as_rows(segs)
                    _place_segments(seg_rows, legend, lang)
                    segments = json.dumps(seg_rows, ensure_ascii=False)
                    latin = " ".join(s.latin or s.text for s in segs)
                    english = " · ".join(s.english or f"[{s.text}]" for s in segs)
                    cov = round(coverage(segs), 3)
                roman = romanised(norm, lang)
                rows.append((type_id, side, lang, legend, norm, norm.replace(" ", ""), roman,
                             transliterate(norm, lang),
                             segments, latin, english, cov))
    db.executemany("""INSERT INTO legend (type_id, side, language, legend, normalised, compact, romanised,
                                          transliteration, segments, expanded_latin, english, gloss_coverage)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", rows)
    db.execute("INSERT INTO legend_fts (rowid, compact, romanised) SELECT id, compact, romanised FROM legend")
    db.execute("""INSERT INTO legend_meaning_fts (rowid, expanded_latin, english)
                  SELECT id, expanded_latin, english FROM legend WHERE english IS NOT NULL""")
    db.commit()
    return len(rows)


def search_meaning(db: sqlite3.Connection, text: str, include_retired: bool = False,
                   limit: int = 200) -> list[tuple[str, str, str, str]]:
    """Search expanded Latin and English glosses: 'father of his country', 'Germanicus'.
    Returns (type_id, side, legend, english)."""
    words = re.findall(r"\w+", text)
    if not words:
        return []
    match = " ".join(f'"{w}"' for w in words)
    retired = "" if include_retired else "AND t.replaced_by_id IS NULL"
    return db.execute(f"""
        SELECT l.type_id, l.side, l.legend, l.english FROM legend_meaning_fts f
        JOIN legend l ON l.id = f.rowid JOIN coin_type t ON t.id = l.type_id
        WHERE legend_meaning_fts MATCH ? {retired}
        ORDER BY l.type_id, l.side LIMIT ?""", (match, limit)).fetchall()


def _pattern(query: str, lang: str = "la") -> tuple[str, list[str]]:
    """'IMP CAES … TRAI?N' -> LIKE pattern '%IMPCAES%TRAI_N%' and its fixed parts."""
    parts = [compact(p.replace("?", "\x00"), lang).replace("\x00", "_") for p in GAP.split(query)]
    parts = [p for p in parts if p.strip("_")]
    return "%" + "%".join(parts) + "%", parts


def search(db: sqlite3.Connection, query: str, side: str | None = None,
           include_retired: bool = False, limit: int = 200) -> list[tuple[str, str, str]]:
    """Fragment search over legends: spacing-insensitive, ordered parts, '?' = one unknown letter,
    '...' / '…' / '*' = any unreadable stretch. Returns (type_id, side, legend).

    Greek legends match however the query is typed: in Greek ('ΑΝΤΙΟΧΟΥ'), in Latin look-alikes
    ('ANTIOXOY', folded to Greek) or transliterated ('antiochou', against the romanised form)."""
    pattern, parts = _pattern(query)
    greek_pattern, _ = _pattern(query, "grc")
    if greek.is_greek(query):
        # A Greek query can also be matched against romanised legends (its transliteration).
        pattern = _pattern(greek.romanise(greek.fold(query)))[0]
    if not parts:
        return []
    # The trigram index serves LIKE when every fixed run is at least 3 letters.
    runs = [r for p in parts for r in p.split("_") if r]
    table = "legend_fts" if runs and all(len(r) >= 3 for r in runs) else "legend"
    if table == "legend":
        where = ["(l.compact LIKE ? OR l.compact LIKE ? OR l.romanised LIKE ?)"]
    else:
        where = ["l.id IN (SELECT rowid FROM legend_fts WHERE compact LIKE ? OR compact LIKE ? OR romanised LIKE ?)"]
    args: list = [pattern, greek_pattern, pattern]
    if side:
        where.append("l.side = ?")
        args.append(side)
    if not include_retired:
        where.append("t.replaced_by_id IS NULL")
    sql = f"""SELECT l.type_id, l.side, l.legend FROM legend l JOIN coin_type t ON t.id = l.type_id
              WHERE {' AND '.join(where)} ORDER BY l.type_id, l.side LIMIT ?"""
    return db.execute(sql, [*args, limit]).fetchall()
