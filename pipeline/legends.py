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

from pipeline.legend_expand import Dictionary, as_rows, coverage, expand

LETTER_MAP = {
    "Ꜹ": "AV", "∈": "E", "Ϥ": "V", "Ʈ": "T", "Λ": "L",
    "U": "V", "J": "I",
}
_EDITORIAL = re.compile(r"\([^)]*[a-z.][^)]*\)")      # '(rev.N)' and similar notes
_WORD_BREAK = re.compile(r"(?<=[\w\]])[-_](?=[\w\[])")   # HONORI-VS -> HONORIVS, NOS-[TRIS] -> NOS[TRIS]
_SEPARATORS = re.compile(r"[\s\-_/|•˙.:●*,?…()← ]+")
GAP = re.compile(r"\s*(?:\.\.\.+|…|\*)\s*")             # what a user types for unreadable stretches
_GREEK = re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")


def language(legend: str) -> str:
    """'grc' if the legend has any Greek letters, else 'la'."""
    return "grc" if _GREEK.search(legend) else "la"


def normalise(legend: str) -> str:
    """'D N HONORI-VS•P•F•AVG' -> 'D N HONORIVS P F AVG'."""
    text = _EDITORIAL.sub("", legend).upper()
    text = "".join(LETTER_MAP.get(ch, ch) for ch in text)
    text = _WORD_BREAK.sub("", text)
    text = re.sub(r"[\[\]]", "", text)                     # restored letters belong to the word
    text = _SEPARATORS.sub(" ", text)
    text = text.replace("�", "")                    # broken characters in the source
    return " ".join(text.split())


def compact(legend: str) -> str:
    return normalise(legend).replace(" ", "")


def build_index(db: sqlite3.Connection, dictionary: "Dictionary | None" = None) -> int:
    rows = []
    for type_id, obv, rev in db.execute("SELECT id, obv_legend, rev_legend FROM coin_type"):
        for side, legend in (("obverse", obv), ("reverse", rev)):
            if legend and (norm := normalise(legend)):
                lang = language(legend)
                latin = english = segments = cov = None
                if dictionary and lang == "la":
                    segs = expand(norm, dictionary)
                    segments = json.dumps(as_rows(segs), ensure_ascii=False)
                    latin = " ".join(s.latin or s.text for s in segs)
                    english = " · ".join(s.english or f"[{s.text}]" for s in segs)
                    cov = round(coverage(segs), 3)
                rows.append((type_id, side, lang, legend, norm, norm.replace(" ", ""), None,
                             segments, latin, english, cov))
    db.executemany("""INSERT INTO legend (type_id, side, language, legend, normalised, compact, romanised,
                                          segments, expanded_latin, english, gloss_coverage)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", rows)
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


def _pattern(query: str) -> tuple[str, list[str]]:
    """'IMP CAES … TRAI?N' -> LIKE pattern '%IMPCAES%TRAI_N%' and its fixed parts."""
    parts = [compact(p.replace("?", "\x00")).replace("\x00", "_") for p in GAP.split(query)]
    parts = [p for p in parts if p.strip("_")]
    return "%" + "%".join(parts) + "%", parts


def search(db: sqlite3.Connection, query: str, side: str | None = None,
           include_retired: bool = False, limit: int = 200) -> list[tuple[str, str, str]]:
    """Fragment search over legends: spacing-insensitive, ordered parts, '?' = one unknown letter,
    '...' / '…' / '*' = any unreadable stretch. Returns (type_id, side, legend)."""
    pattern, parts = _pattern(query)
    if not parts:
        return []
    # The trigram index serves LIKE when every fixed run is at least 3 letters.
    runs = [r for p in parts for r in p.split("_") if r]
    table = "legend_fts" if runs and all(len(r) >= 3 for r in runs) else "legend"
    if table == "legend":
        where = ["(l.compact LIKE ? OR l.romanised LIKE ?)"]
    else:
        where = ["l.id IN (SELECT rowid FROM legend_fts WHERE compact LIKE ? OR romanised LIKE ?)"]
    args: list = [pattern, pattern]
    if side:
        where.append("l.side = ?")
        args.append(side)
    if not include_retired:
        where.append("t.replaced_by_id IS NULL")
    sql = f"""SELECT l.type_id, l.side, l.legend FROM legend l JOIN coin_type t ON t.id = l.type_id
              WHERE {' AND '.join(where)} ORDER BY l.type_id, l.side LIMIT ?"""
    return db.execute(sql, [*args, limit]).fetchall()
