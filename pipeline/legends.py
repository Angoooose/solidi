"""Legend normalisation and fragment search.

OCRE writes legends diplomatically: '-' and '_' mark line breaks inside words, '/' and '//'
separate fields, [ ] mark restored letters, dots divide words, (lowercase notes) are editorial,
and a few special letters stand for Latin ones (Ꜹ = AV, ∈ = E, Ϥ = V). Collectors type legends
with inconsistent spacing, so search compares a space-free 'compact' form.
"""

from __future__ import annotations

import re
import sqlite3

LETTER_MAP = {
    "Ꜹ": "AV", "∈": "E", "Ϥ": "V", "Ʈ": "T", "Λ": "L",
    "U": "V", "J": "I",
}
_EDITORIAL = re.compile(r"\([^)]*[a-z.][^)]*\)")      # '(rev.N)' and similar notes
_WORD_BREAK = re.compile(r"(?<=[\w\]])[-_](?=[\w\[])")   # HONORI-VS -> HONORIVS, NOS-[TRIS] -> NOS[TRIS]
_SEPARATORS = re.compile(r"[\s\-_/|•˙.:●*,?…()← ]+")
GAP = re.compile(r"\s*(?:\.\.\.+|…|\*)\s*")             # what a user types for unreadable stretches


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


def build_index(db: sqlite3.Connection) -> int:
    rows = []
    for type_id, obv, rev in db.execute("SELECT id, obv_legend, rev_legend FROM coin_type"):
        for side, legend in (("obverse", obv), ("reverse", rev)):
            if legend and (norm := normalise(legend)):
                rows.append((type_id, side, legend, norm, norm.replace(" ", "")))
    db.executemany("""INSERT INTO legend (type_id, side, legend, normalised, compact)
                      VALUES (?, ?, ?, ?, ?)""", rows)
    db.execute("INSERT INTO legend_fts (rowid, compact) SELECT id, compact FROM legend")
    db.commit()
    return len(rows)


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
    where = ["l.compact LIKE ?"] if table == "legend" else ["l.id IN (SELECT rowid FROM legend_fts WHERE compact LIKE ?)"]
    args: list = [pattern]
    if side:
        where.append("l.side = ?")
        args.append(side)
    if not include_retired:
        where.append("t.replaced_by_id IS NULL")
    sql = f"""SELECT l.type_id, l.side, l.legend FROM legend l JOIN coin_type t ON t.id = l.type_id
              WHERE {' AND '.join(where)} ORDER BY l.type_id, l.side LIMIT ?"""
    return db.execute(sql, [*args, limit]).fetchall()
