"""Score our legend expansions against Neel Smith's scholar-expanded OCRE legends (ocre-texts, ODbL).

    uv run python -m pipeline.eval_legends            # summary
    uv run python -m pipeline.eval_legends --show 30  # plus the worst disagreements

Their expansions are lowercase Latin with Unicode numerals ('consvl Ⅲ'); ours use the dictionary.
We compare word sequences after normalising case, u/v and numerals.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import io
import re
from pathlib import Path

import httpx

from pipeline.legend_expand import Dictionary, expand
from pipeline.legends import normalise

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://raw.githubusercontent.com/neelsmith/ocre-texts/master/mappings/mappings{}.csv"
UNICODE_NUMERALS = {chr(0x2160 + i): r for i, r in enumerate(
    ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"])}


def pairs(cache: Path) -> list[tuple[str, str]]:
    if not cache.exists():
        text = "\n".join(httpx.get(BASE.format(i), timeout=60).text for i in range(23))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text, encoding="utf-8")
    out = []
    for row in csv.reader(io.StringIO(cache.read_text(encoding="utf-8"))):
        if len(row) >= 2 and row[0].strip():
            out.append((row[0].replace("_", ""), row[1]))
    return out


def words(text: str) -> list[str]:
    text = "".join(UNICODE_NUMERALS.get(ch, ch) for ch in text)
    return re.findall(r"[a-z]+", text.lower().replace("u", "v").replace("j", "i"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--show", type=int, default=0)
    args = parser.parse_args()
    dictionary = Dictionary.load(ROOT / "data" / "legend_abbreviations.yaml")
    data = pairs(ROOT / "build" / "raw" / "ocre_texts" / "pairs.csv")

    scores, exact, results = [], 0, []
    for abbreviated, theirs in data:
        segs = expand(normalise(abbreviated), dictionary)
        ours = " ".join(s.latin or s.text for s in segs)
        a, b = words(ours), words(theirs)
        ratio = difflib.SequenceMatcher(a=a, b=b).ratio()
        scores.append(ratio)
        exact += a == b
        results.append((ratio, abbreviated, ours, theirs))

    print(f"legends: {len(data)}  exact match: {100 * exact / len(data):.1f}%  "
          f"mean word agreement: {100 * sum(scores) / len(scores):.1f}%")
    for ratio, abbreviated, ours, theirs in sorted(results)[:args.show]:
        print(f"\n{ratio:.2f}  {abbreviated}\n  ours:   {ours}\n  theirs: {theirs}")


if __name__ == "__main__":
    main()
