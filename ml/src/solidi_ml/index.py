"""How small can the search index be before it stops finding coins?

The index is what a browser must download to search: the gallery's vectors. As the model gives
them (768 numbers a side, every gallery coin) it is far too large. This measures what each way of
shrinking it costs on the held-out collections:

- fewer coins: keep at most N coins of each type, or one averaged vector per type;
- fewer numbers: turn the vectors onto their directions of most variation and keep the first few
  (principal component analysis). The turn is a matrix, so in a browser it folds into the model's
  last layer and costs nothing to ship;
- smaller numbers: one byte each (int8), one bit each (the sign), or product quantisation, which
  cuts a vector into M parts and stores each as the nearest of 256 learned patterns: M bytes a
  vector (Jegou et al., "Product quantization for nearest neighbor search", 2011).

Only the gallery is shrunk. The query is one vector computed on the spot, so it stays exact and
is compared with what the stored codes stand for.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass, replace

import numpy as np
import torch
from torch.nn import functional as F

from . import evaluate
from .records import Specimen

PATTERNS = 256          # learned patterns per part in product quantisation: one byte
TYPE_BYTES = 4          # per coin, to say which type it is


@dataclass(frozen=True)
class Variant:
    coins: int | str = 0     # coins kept per type: 0 for all, N for at most N, "mean" for one average
    dims: int = 0            # numbers kept per side: 0 for all of them, unturned
    code: str = "float32"    # how each is stored: float32, float16, int8, bit, or pq<M>

    @property
    def parts(self) -> int:
        return int(self.code[2:]) if self.code.startswith("pq") else 0


VARIANTS = (
    Variant(), Variant(code="float16"), Variant(code="int8"), Variant(code="bit"),
    Variant(dims=384, code="int8"), Variant(dims=384, code="bit"),
    Variant(dims=256, code="int8"), Variant(dims=256, code="bit"),
    Variant(dims=256, code="pq64"), Variant(dims=256, code="pq32"),
    Variant(dims=128, code="int8"), Variant(dims=128, code="pq32"), Variant(dims=128, code="pq16"),
    Variant(dims=64, code="int8"),
    Variant(coins=10), Variant(coins=5), Variant(coins=3), Variant(coins=1), Variant(coins="mean"),
    Variant(coins=10, dims=256, code="int8"), Variant(coins=10, dims=256, code="pq32"),
    Variant(coins=5, dims=256, code="int8"), Variant(coins=5, dims=256, code="pq32"),
    Variant(coins=3, dims=256, code="int8"), Variant(coins="mean", dims=256, code="int8"),
)


def fit_turn(vectors: torch.Tensor, device: str) -> tuple[torch.Tensor, torch.Tensor]:
    """The vectors' mean, and their directions of variation as columns, the widest first."""
    mean = vectors.mean(dim=0)
    spread = torch.zeros(vectors.shape[1], vectors.shape[1], device=device)
    for start in range(0, len(vectors), 65536):
        part = (vectors[start:start + 65536] - mean).to(device)
        spread += part.T @ part
    _, directions = torch.linalg.eigh(spread.double().cpu())
    return mean, directions.flip(1).float()


def _mixing(dims: int, seed: int) -> torch.Tensor:
    """A random turn. After `fit_turn` the first numbers vary most; product quantisation gives
    every part one byte, so the variation is spread evenly across the parts first."""
    noise = torch.randn(dims, dims, generator=torch.Generator().manual_seed(seed))
    return torch.linalg.qr(noise).Q


def turn(vectors: torch.Tensor, mean: torch.Tensor, directions: torch.Tensor, dims: int,
         mixing: torch.Tensor | None = None) -> torch.Tensor:
    """Unit vectors of the first `dims` directions."""
    out = (vectors - mean) @ directions[:, :dims]
    return F.normalize(out @ mixing if mixing is not None else out, dim=1)


def quantise(vectors: torch.Tensor, parts: int, device: str, seed: int = 0, rounds: int = 20,
             sample: int = 200_000) -> torch.Tensor:
    """Product quantisation: each vector as its stored code would be read back."""
    n, dims = vectors.shape
    if dims % parts:
        raise ValueError(f"{dims} numbers can't be cut into {parts} equal parts")
    width = dims // parts
    random = torch.Generator().manual_seed(seed)
    learn = vectors[torch.randperm(n, generator=random)[:sample]].to(device)
    out = torch.empty_like(vectors)
    for p in range(parts):
        columns = slice(p * width, (p + 1) * width)
        x = learn[:, columns]
        patterns = x[torch.randperm(len(x), generator=random)[:PATTERNS]].clone()
        for _ in range(rounds):   # k-means
            nearest = torch.cdist(x, patterns).argmin(dim=1)
            sums = torch.zeros_like(patterns).index_add_(0, nearest, x)
            counts = torch.bincount(nearest, minlength=len(patterns))[:, None]
            patterns = torch.where(counts > 0, sums / counts.clamp(min=1), patterns)
        for start in range(0, n, 65536):
            part = vectors[start:start + 65536, columns].to(device)
            out[start:start + 65536, columns] = patterns[torch.cdist(part, patterns).argmin(dim=1)].cpu()
    return out


def store(vectors: torch.Tensor, variant: Variant, device: str) -> tuple[torch.Tensor, int, int]:
    """The vectors as the index would hold them (read back as numbers), the bytes each takes, and
    the bytes of anything stored once."""
    dims = vectors.shape[1]
    if variant.code == "float32":
        return vectors, 4 * dims, 0
    if variant.code == "float16":
        return vectors.half().float(), 2 * dims, 0
    if variant.code == "int8":
        some = vectors[torch.randperm(len(vectors), generator=torch.Generator().manual_seed(0))[:4096]]
        scale = 127 / torch.quantile(some.abs().flatten()[:8_000_000], 0.999).clamp(min=1e-6)
        return (vectors * scale).round().clamp(-127, 127) / scale, dims, 4
    if variant.code == "bit":
        return torch.where(vectors >= 0, 1.0, -1.0) / dims ** 0.5, (dims + 7) // 8, 0
    if variant.parts:
        return quantise(vectors, variant.parts, device), variant.parts, PATTERNS * dims * 4
    raise ValueError(f"unknown code {variant.code!r}")


def keep(gallery: list[Specimen], obverse: torch.Tensor, reverse: torch.Tensor, coins: int | str
         ) -> tuple[list[Specimen], torch.Tensor, torch.Tensor]:
    """The gallery cut down to at most `coins` of each type (which ones is arbitrary but
    repeatable), or to one made-up coin per type whose sides are the averages of its coins'."""
    if not coins:
        return gallery, obverse, reverse
    members: dict[str, list[int]] = defaultdict(list)
    for i, s in enumerate(gallery):
        members[s.type_id].append(i)
    if coins == "mean":
        groups = [members[t] for t in sorted(members)]
        made = [replace(gallery[g[0]], id=f"type:{gallery[g[0]].type_id}", collection="mean", photos=[])
                for g in groups]
        average = lambda v: F.normalize(torch.stack([v[g].mean(dim=0) for g in groups]), dim=1)
        return made, average(obverse), average(reverse)
    shuffled = lambda i: hashlib.sha1(gallery[i].id.encode()).hexdigest()
    chosen = sorted(i for group in members.values() for i in sorted(group, key=shuffled)[:coins])
    return [gallery[i] for i in chosen], obverse[chosen], reverse[chosen]


def measure(specimens: list[Specimen], views: list[tuple[str, str]], gallery_vectors: np.ndarray,
            query_vectors: np.ndarray, variants: tuple[Variant, ...] = VARIANTS,
            device: str | None = None, log=print) -> dict:
    """Grade the held-out coins against each variant of the index. `gallery_vectors` and
    `query_vectors` hold one row per view: the same array when one model embeds both, or the
    teacher's and the student's."""
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    rows = evaluate.complete(specimens, views)
    gallery, held_out, _ = evaluate.split(specimens, rows)
    side = lambda coins, vectors, i: torch.from_numpy(
        vectors[[rows[s.id][i] for s in coins]].astype(np.float32))
    g_obverse, g_reverse = side(gallery, gallery_vectors, 0), side(gallery, gallery_vectors, 1)
    queries = torch.cat([side(held_out, query_vectors, 0), side(held_out, query_vectors, 1)])
    q_rows = {s.id: (i, len(held_out) + i) for i, s in enumerate(held_out)}
    width = g_obverse.shape[1]
    log(f"gallery: {len(gallery):,} coins of {len({g.type_id for g in gallery}):,} types, "
        f"{width} numbers a side; {len(held_out):,} held-out queries")
    mean, directions = fit_turn(torch.cat([g_obverse, g_reverse]), device)
    out = []
    for v in variants:
        dims = min(v.dims or width, width)
        kept, obverse, reverse = keep(gallery, g_obverse, g_reverse, v.coins)
        stored, asked = torch.cat([obverse, reverse]), queries
        if v.dims or v.parts:
            mixing = _mixing(dims, seed=0) if v.parts else None
            stored = turn(stored, mean, directions, dims, mixing)
            asked = turn(queries, mean, directions, dims, mixing)
        stored, each, once = store(stored, v, device)
        g_rows = {s.id: (i, len(kept) + i) for i, s in enumerate(kept)}
        summary = evaluate.summary(evaluate.run(held_out, kept, g_rows, stored, device,
                                                query_sets=[(q_rows, asked)]))
        row = {"coins": v.coins, "dims": dims, "code": v.code, "kept": len(kept),
               "bytes": len(kept) * (2 * each + TYPE_BYTES) + once,
               "type_top1": summary["type"]["both"]["top1"], "type_top10": summary["type"]["both"]["top10"],
               "design_top10": summary["design"]["both"]["top10"]}
        out.append(row)
        log(f"{_coins(row):<16} {dims:>4} x {v.code:<8} {_size(row['bytes']):>9}   "
            f"type top 1 {100 * row['type_top1']:.1f}%, top 10 {100 * row['type_top10']:.1f}%")
    return {"gallery": {"specimens": len(gallery), "types": len({g.type_id for g in gallery})},
            "queries": len(held_out), "variants": out}


def _coins(row: dict) -> str:
    if row["coins"] == "mean":
        return "type average"
    return f"up to {row['coins']} a type" if row["coins"] else "all"


def _size(n: int) -> str:
    return f"{n / 1e6:,.1f} MB"


def markdown(report: dict) -> str:
    pct = lambda x: f"{100 * x:.1f}%"
    same = report["gallery_model"] == report["query_model"]
    out = ["# Index size against accuracy", "",
           f"Dataset {report['dataset']}. Gallery embedded by `{report['gallery_model']}`"
           + ("," if same else f", queries by `{report['query_model']}`,")
           + f" {report['queries']:,} held-out queries. Unshrunk, the gallery is "
             f"{report['gallery']['specimens']:,} coins of {report['gallery']['types']:,} types.",
           "", "Each row shrinks the gallery one way and searches it with exact query vectors. The "
               "size is the vectors plus four bytes a coin for its type, before any compression "
               "in transit.",
           "", "| Coins kept | Coins | Numbers a side | Stored as | Index size | Type top 1 | "
               "Type top 10 | Design top 10 |", "|---|---|---|---|---|---|---|---|"]
    for row in report["variants"]:
        out.append(f"| {_coins(row)} | {row['kept']:,} | {row['dims']} | {row['code']} | "
                   f"{_size(row['bytes'])} | {pct(row['type_top1'])} | {pct(row['type_top10'])} | "
                   f"{pct(row['design_top10'])} |")
    return "\n".join(out) + "\n"
