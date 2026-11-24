"""Grade the vectors: given a coin the gallery hasn't seen, how high does its true type rank?

Two tests, both searching the gallery collections:

- held out: every coin from the other collections (different photographers and lighting). This is
  the number that matters.
- same collection: each ANS coin searched against all the others. Easier, because the photos
  share a studio, but there are far more of them.

A query's two sides are compared with every gallery coin's two sides. Each type scores as its
best-matching coin, and types are ranked by that score. "Top 10" means the true type is among the
ten best. Labels (portrait, denomination, mint) are graded on the single nearest coin.
"""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
import torch

from .records import GALLERY, Specimen

MODES = ("obverse", "reverse", "both")
LABELS = ("portrait", "denomination", "mint")
TOPS = (1, 5, 10)
BUCKETS = ((1, 1, "1"), (2, 4, "2-4"), (5, 9, "5-9"), (10, 10**9, "10+"))
CHUNK = 512
NEAREST = 3            # nearest gallery coins kept per query, for looking at afterwards


def _bucket(n: int) -> str:
    return next(name for low, high, name in BUCKETS if low <= n <= high)


def complete(specimens: list[Specimen], views: list[tuple[str, str]]) -> dict[str, tuple[int, int]]:
    """Specimens with a vector for both sides: id -> (obverse row, reverse row)."""
    rows: dict[str, dict[str, int]] = defaultdict(dict)
    for row, (sid, side) in enumerate(views):
        rows[sid][side] = row
    return {s.id: (rows[s.id]["obverse"], rows[s.id]["reverse"]) for s in specimens
            if len(rows.get(s.id, ())) == 2}


def split(specimens: list[Specimen], rows: dict[str, tuple[int, int]]
          ) -> tuple[list[Specimen], list[Specimen], list[Specimen]]:
    """The gallery, the held-out queries and the same-collection queries."""
    usable = [s for s in specimens if s.id in rows]
    gallery = [s for s in usable if s.collection in GALLERY]
    gallery_types = Counter(s.type_id for s in gallery)
    held_out = [s for s in usable if s.collection not in GALLERY and s.type_id in gallery_types]
    same = [s for s in gallery if s.collection == "ans" and gallery_types[s.type_id] >= 2]
    return gallery, held_out, same


def run(queries: list[Specimen], gallery: list[Specimen], rows: dict[str, tuple[int, int]],
        vectors: torch.Tensor, device: str,
        query_sets: list[tuple[dict[str, tuple[int, int]], torch.Tensor]] | None = None) -> list[dict]:
    """One result per query: the true type's rank in each mode, the nearest coins and whether
    the nearest one shares each label.

    `query_sets` gives alternative vectors for the queries (say, the same pictures turned);
    each gallery coin then scores as its best match over the sets. The gallery always comes
    from `rows` and `vectors`."""
    query_sets = query_sets or [(rows, vectors)]
    type_ids = sorted({g.type_id for g in gallery})
    type_index = {t: i for i, t in enumerate(type_ids)}
    gallery_type = torch.tensor([type_index[g.type_id] for g in gallery], device=device)
    gallery_row = {g.id: i for i, g in enumerate(gallery)}
    per_type = Counter(g.type_id for g in gallery)
    side = {"obverse": 0, "reverse": 1}
    g_vec = {m: vectors[[rows[g.id][i] for g in gallery]].to(device) for m, i in side.items()}
    keep = min(NEAREST, len(gallery))
    results = []
    for start in range(0, len(queries), CHUNK):
        chunk = queries[start:start + CHUNK]
        sims, best_set = {}, None
        for m, i in side.items():
            closest = None   # each query's best single match so far, to see which set won
            for n, (set_rows, set_vectors) in enumerate(query_sets):
                s = set_vectors[[set_rows[q.id][i] for q in chunk]].to(device) @ g_vec[m].T
                if n == 0:
                    sims[m], closest = s, s.amax(dim=1)
                    won = torch.zeros(len(chunk), dtype=torch.long, device=device)
                else:
                    better = s.amax(dim=1) > closest
                    won[better], closest = n, torch.maximum(closest, s.amax(dim=1))
                    sims[m] = torch.maximum(sims[m], s)
            if m == "obverse":
                best_set = won.tolist()
        sims["both"] = (sims["obverse"] + sims["reverse"]) / 2
        own = [(b, gallery_row[q.id]) for b, q in enumerate(chunk) if q.id in gallery_row]
        true = torch.tensor([type_index[q.type_id] for q in chunk], device=device)
        ranks, nearest = {}, None
        for mode in MODES:
            s = sims[mode]
            if own:   # a coin must not find itself
                b, g = zip(*own)
                s[list(b), list(g)] = -torch.inf
            by_type = torch.full((len(chunk), len(type_ids)), -torch.inf, device=device)
            by_type.scatter_reduce_(1, gallery_type.expand(len(chunk), -1), s, "amax")
            true_score = by_type.gather(1, true[:, None])
            ranks[mode] = ((by_type > true_score).sum(dim=1) + 1).tolist()
            if mode == "both":
                nearest = s.topk(keep, dim=1).indices.tolist()
        for b, q in enumerate(chunk):
            neighbour = gallery[nearest[b][0]]
            results.append({
                "id": q.id, "collection": q.collection, "corpus": q.corpus or "unknown",
                "bucket": _bucket(per_type[q.type_id] - (q.id in gallery_row)),
                "rank": {mode: ranks[mode][b] for mode in MODES},
                "nearest": [gallery[g].id for g in nearest[b]],
                "set": best_set[b],
                "labels": {name: q.label(name) == neighbour.label(name)
                           for name in LABELS if q.label(name)},
            })
    return results


def _top(results: list[dict], mode: str) -> dict:
    ranks = np.array([r["rank"][mode] for r in results])
    return {f"top{k}": float((ranks <= k).mean()) for k in TOPS}


def summary(results: list[dict]) -> dict:
    if not results:
        return {"queries": 0}
    out = {"queries": len(results), "type": {mode: _top(results, mode) for mode in MODES}}
    out["labels"] = {}
    for name in LABELS:
        hits = [r["labels"][name] for r in results if name in r["labels"]]
        if hits:
            out["labels"][name] = {"queries": len(hits), "top1": float(np.mean(hits))}
    for key in ("corpus", "collection", "bucket"):
        groups: dict[str, list[dict]] = defaultdict(list)
        for r in results:
            groups[r[key]].append(r)
        order = [name for _, _, name in BUCKETS] if key == "bucket" else sorted(groups)
        out[f"by_{key}"] = {name: {"queries": len(groups[name]), **_top(groups[name], "both")}
                            for name in order if name in groups}
    return out


def evaluate(specimens: list[Specimen], views: list[tuple[str, str]], vectors: np.ndarray,
             log=print) -> dict:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    rows = complete(specimens, views)
    gallery, held_out, same = split(specimens, rows)
    log(f"gallery: {len(gallery):,} coins of {len({g.type_id for g in gallery}):,} types; "
        f"queries: {len(held_out):,} held out, {len(same):,} same collection")
    tensor = torch.from_numpy(vectors.astype(np.float32))
    return {
        "gallery": {"specimens": len(gallery), "types": len({g.type_id for g in gallery}),
                    "collections": dict(Counter(s.collection for s in gallery))},
        "specimens_with_both_sides": len(rows),
        "held_out": summary(run(held_out, gallery, rows, tensor, device)),
        "same_collection": summary(run(same, gallery, rows, tensor, device)),
    }


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _table(header: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    return "\n".join(lines + ["| " + " | ".join(r) + " |" for r in rows])


def markdown(report: dict) -> str:
    """The report as text a person can read."""
    out = [f"# Baseline: {report['model']} at {report['resolution']}px, no training", "",
           f"Release `{report['release']}`. Gallery: {report['gallery']['specimens']:,} coins of "
           f"{report['gallery']['types']:,} types "
           f"({', '.join(f'{k} {v:,}' for k, v in report['gallery']['collections'].items())})."]
    titles = {"held_out": "Held-out collections", "same_collection": "Same collection (ANS, leave one out)"}
    for key, title in titles.items():
        test = report[key]
        out += ["", f"## {title}", ""]
        if not test["queries"]:
            out.append("No queries.")
            continue
        out += [f"{test['queries']:,} queries. Share whose true type ranks in the top 1, 5 and 10:", "",
                _table(["Sides used", "Top 1", "Top 5", "Top 10"],
                       [[mode] + [_pct(test["type"][mode][f"top{k}"]) for k in TOPS] for mode in MODES]),
                "", "Nearest coin has the same label (both sides):", "",
                _table(["Label", "Queries", "Correct"],
                       [[name, f"{v['queries']:,}", _pct(v["top1"])] for name, v in test["labels"].items()])]
        for group, heading in (("corpus", "Catalogue"), ("collection", "Query collection"),
                               ("bucket", "Gallery coins of the true type")):
            out += ["", _table([heading, "Queries", "Top 1", "Top 10"],
                               [[name, f"{v['queries']:,}", _pct(v["top1"]), _pct(v["top10"])]
                                for name, v in test[f"by_{group}"].items()])]
    return "\n".join(out) + "\n"
