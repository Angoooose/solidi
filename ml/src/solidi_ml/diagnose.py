"""Why does the baseline miss? Three checks on the held-out coins, each against the same gallery.

- greyscale: every picture, gallery and query, with its colour removed. If scores rise, the model
  was matching metal colour, toning or the tint of the lighting rather than the design.
- rotation: each query also embedded turned in 45-degree steps, keeping the best match. If scores
  rise, the held-out photos are not the same way up as the gallery's. A sample of ANS coins gets
  the same treatment, to show how often an upright coin's best match is the upright picture.
- a sheet of misses: query coins beside their three nearest gallery coins, to look at.
"""

from __future__ import annotations

import random
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from . import crops, evaluate
from .embed import embed
from .records import Specimen

ANGLES = (45, 90, 135, 180, 225, 270, 315)
SHEET_ROWS = 30
CONTROL = 2000         # ANS coins turned the same way, as a yardstick for the rotation check
CELL = 112
CAPTION = 14
HIT, NEAR, MISS = (40, 150, 70), (225, 150, 20), (200, 50, 40)


def miss_sheet(results: list[dict], by_id: dict[str, Specimen], crop_of: dict[tuple[str, str], Path],
               out: Path, seed: int = 0) -> int:
    """Save a picture of queries whose true type ranked outside the top 10. Each row is the query
    (obverse, reverse) and then its three nearest gallery coins, outlined green when the coin is
    of the query's type, amber when it is another type of the same design, and red otherwise.
    Returns the number of rows."""
    misses = [r for r in results if r["rank"]["type"]["both"] > 10]
    rows = random.Random(seed).sample(misses, min(SHEET_ROWS, len(misses)))
    if not rows:
        return 0
    pairs = 1 + max(len(r["nearest"]) for r in rows)
    sheet = Image.new("RGB", (pairs * (2 * CELL + 12), len(rows) * (CELL + CAPTION + 8)), "white")
    draw = ImageDraw.Draw(sheet)
    for y, result in enumerate(rows):
        top = y * (CELL + CAPTION + 8)
        query = by_id[result["id"]]
        draw.text((2, top), f"{query.collection}  {query.type_id}  (true type ranked "
                            f"{result['rank']['type']['both']:,}, design "
                            f"{result['rank']['design']['both']:,})", fill="black")
        for x, specimen in enumerate([query] + [by_id[g] for g in result["nearest"]]):
            left = x * (2 * CELL + 12)
            for i, side in enumerate(("obverse", "reverse")):
                if (specimen.id, side) in crop_of:
                    picture = Image.open(crop_of[specimen.id, side]).convert("RGB")
                    sheet.paste(picture.resize((CELL, CELL)), (left + i * CELL, top + CAPTION))
            if x:
                colour = (HIT if specimen.type_id == query.type_id
                          else NEAR if specimen.design == query.design else MISS)
                draw.rectangle((left - 1, top + CAPTION - 1, left + 2 * CELL, top + CAPTION + CELL),
                               outline=colour, width=3)
    sheet.save(out)
    return len(rows)


def _line(results: list[dict]) -> dict:
    s = evaluate.summary(results)
    return {"queries": s["queries"], **{k: s["type"]["both"][k] for k in ("top1", "top10")},
            "design_top10": s["design"]["both"]["top10"],
            **{name: s["labels"].get(name, {}).get("top1") for name in ("portrait", "denomination")}}


def diagnose(specimens: list[Specimen], data_dir: Path, out_dir: Path, log=print, **embed_args) -> dict:
    device = "cuda" if torch.cuda.is_available() else "cpu"

    views = crops.prepare(specimens, data_dir, embed_args.get("workers"), log=log)

    def vectors_for(subset: list[Specimen], **variant):
        wanted = {s.id for s in subset}
        chosen = [v for v in views if v.specimen_id in wanted]
        vectors = embed(chosen, data_dir, log=log, **embed_args, **variant)
        return (evaluate.complete(subset, [(v.specimen_id, v.side) for v in chosen]),
                torch.from_numpy(vectors.astype(np.float32)))

    rows, tensor = vectors_for(specimens)
    gallery, held_out, same = evaluate.split(specimens, rows)
    log(f"gallery: {len(gallery):,} coins; {len(held_out):,} held-out queries")
    base = evaluate.run(held_out, gallery, rows, tensor, device)
    report = {"held_out": {"as photographed": _line(base)},
              "same_collection": {"as photographed": _line(evaluate.run(same, gallery, rows, tensor, device))}}

    gray_rows, gray_tensor = vectors_for(specimens, gray=True)
    g_gallery, g_held, g_same = evaluate.split(specimens, gray_rows)
    report["held_out"]["greyscale"] = _line(evaluate.run(g_held, g_gallery, gray_rows, gray_tensor, device))
    report["same_collection"]["greyscale"] = _line(
        evaluate.run(g_same, g_gallery, gray_rows, gray_tensor, device))

    turned = [vectors_for(held_out, angle=angle) for angle in ANGLES]
    in_all = [q for q in held_out if all(q.id in set_rows for set_rows, _ in turned)]
    rotated = evaluate.run(in_all, gallery, rows, tensor, device, query_sets=[(rows, tensor)] + turned)
    report["held_out"]["best of 8 rotations"] = _line(rotated)
    won = Counter(r["set"] for r in rotated)
    report["winning_angle"] = {str(angle): won[i] / len(rotated)
                               for i, angle in enumerate((0,) + ANGLES)} if rotated else {}
    by_collection: dict[str, list[dict]] = {}
    for r in rotated:
        by_collection.setdefault(r["collection"], []).append(r)
    report["upright_by_collection"] = {c: sum(r["set"] == 0 for r in rs) / len(rs)
                                       for c, rs in sorted(by_collection.items())}
    # The yardstick: gallery coins are upright, so how often does "upright" win for them? A turned
    # picture sometimes matches better by chance, so this is well short of 100%.
    control = random.Random(0).sample(same, min(CONTROL, len(same)))
    if control:
        turned = [vectors_for(control, angle=angle) for angle in ANGLES]
        results = evaluate.run(control, gallery, rows, tensor, device, query_sets=[(rows, tensor)] + turned)
        report["upright_by_collection"][f"ans (control, {len(control):,} coins)"] = (
            sum(r["set"] == 0 for r in results) / len(results))

    by_id = {s.id: s for s in specimens}
    crop_of = {(v.specimen_id, v.side): v.path for v in views}
    report["sheet_rows"] = miss_sheet(base, by_id, crop_of, out_dir / "misses.png")
    return report


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def markdown(report: dict) -> str:
    def table(lines: dict) -> list[str]:
        out = ["| Pictures | Queries | Type top 1 | Type top 10 | Design top 10 | Portrait | Denomination |",
               "|---|---|---|---|---|---|---|"]
        return out + [f"| {name} | {v['queries']:,} | {_pct(v['top1'])} | {_pct(v['top10'])} | "
                      f"{_pct(v['design_top10'])} | {_pct(v['portrait'])} | {_pct(v['denomination'])} |"
                      for name, v in lines.items()]

    out = [f"# Diagnostics: {report['model']} at {report['resolution']}px, no training", "",
           f"Dataset {report['dataset']}. Type ranks use both sides; labels are graded on the nearest coin.",
           "", "## Held-out collections", "", *table(report["held_out"]),
           "", "## Same collection (ANS, leave one out)", "", *table(report["same_collection"]),
           "", "## Which way up are the held-out photos?", "",
           "Share of held-out queries whose obverse matched the gallery best at each angle.", "",
           "| Angle | " + " | ".join(report["winning_angle"]) + " |",
           "|---|" + "---|" * len(report["winning_angle"]),
           "| Share | " + " | ".join(_pct(v) for v in report["winning_angle"].values()) + " |",
           "", "How often the upright picture gave the best match. The ANS control row is the "
               "yardstick: its coins are known to be upright, so a collection well below it has "
               "photos that are turned.",
           "", "| Collection | Best match was upright |", "|---|---|",
           *[f"| {c} | {_pct(v)} |" for c, v in report["upright_by_collection"].items()],
           "", f"`misses.png` shows {report['sheet_rows']} held-out coins whose true type ranked "
               "outside the top 10, each with its three nearest gallery coins (green outline: same "
               "type as the query; amber: another type of the same design; red: a different design)."]
    return "\n".join(out) + "\n"
