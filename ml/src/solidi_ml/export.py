"""Write what a browser needs to identify a coin, and grade it as the browser will use it.

Two things are written:

- the search index: one vector per type and side (the average of that type's gallery coins),
  turned onto its widest directions and product-quantised, as chosen with `index`;
- the model, in ONNX, the format browsers can run. It ends with the same turn as the index, so
  its output can be compared with the index directly. Three copies, to see what size costs:
  as trained (32-bit numbers), in half precision (16-bit throughout), and with its weights stored
  as one byte each and turned back into ordinary numbers when loaded.

The one-byte copy rounds only the stored weights. The usual 8-bit conversion also rounds the
numbers flowing through the network, and on this model that wrecks the vectors (their similarity
to the originals falls to about 0.7).

Each copy then embeds the held-out coins through ONNX Runtime, the engine a browser uses, and
searches the index read back from its file.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch import nn
from torch.nn import functional as F
from tqdm import tqdm

from . import evaluate, index
from .crops import View
from .embed import load_model, to_tensor
from .records import Specimen

MODELS = (("model.onnx", "as trained, 32-bit"),
          ("model-fp16.onnx", "half precision, 16-bit"),
          ("model-int8.onnx", "weights stored as one byte"))
OPSET = 17
SMALL = 4096            # weight tensors with fewer numbers than this are left alone


class Browser(nn.Module):
    """The model as the browser runs it: pixels in, a unit vector in the index's space out."""

    def __init__(self, model: nn.Module, mean: torch.Tensor, turn: torch.Tensor) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("mean", mean)
        self.register_buffer("turn", turn)

    def forward(self, pixels: torch.Tensor) -> torch.Tensor:
        vector = F.normalize(self.model(pixels), dim=1)
        return F.normalize((vector - self.mean) @ self.turn, dim=1)


def to_onnx(model: nn.Module, path: Path, resolution: int) -> None:
    for module in model.modules():       # spell attention out in basic steps, which convert cleanly
        if hasattr(module, "fused_attn"):
            module.fused_attn = False
    torch.onnx.export(model.eval(), (torch.zeros(2, 3, resolution, resolution),), str(path),
                      input_names=["pixels"], output_names=["vector"], opset_version=OPSET,
                      dynamic_axes={"pixels": {0: "batch"}, "vector": {0: "batch"}}, dynamo=False)


def halve(source: Path, target: Path) -> None:
    """The same network computing in 16-bit numbers; pixels in and vector out stay 32-bit."""
    import onnx
    from onnxconverter_common import float16
    onnx.save(float16.convert_float_to_float16(onnx.load(str(source)), keep_io_types=True), str(target))


def shrink_weights(source: Path, target: Path) -> None:
    """Store each large weight tensor as one byte per number, with a scale per output channel,
    and have the network turn it back into 32-bit numbers as it loads."""
    import onnx
    from onnx import helper, numpy_helper
    model = onnx.load(str(source))
    graph, restore = model.graph, []
    for weight in list(graph.initializer):
        values = numpy_helper.to_array(weight)
        if values.dtype != np.float32 or values.size < SMALL:
            continue
        axis = values.ndim - 1 if values.ndim == 2 else 0     # MatMul weights are [in, out]
        others = tuple(i for i in range(values.ndim) if i != axis)
        scale = (np.abs(values).max(axis=others) / 127).astype(np.float32)
        scale[scale == 0] = 1
        along = [-1 if i == axis else 1 for i in range(values.ndim)]
        rounded = np.clip(np.round(values / scale.reshape(along)), -127, 127).astype(np.int8)
        name = weight.name
        graph.initializer.remove(weight)
        graph.initializer.extend([numpy_helper.from_array(rounded, f"{name}_bytes"),
                                  numpy_helper.from_array(scale, f"{name}_scale"),
                                  numpy_helper.from_array(np.zeros(len(scale), np.int8), f"{name}_zero")])
        restore.append(helper.make_node("DequantizeLinear", [f"{name}_bytes", f"{name}_scale", f"{name}_zero"],
                                        [name], axis=axis))
    for node in reversed(restore):
        graph.node.insert(0, node)
    onnx.save(model, str(target))


def run_onnx(path: Path, pictures: list[Path], resolution: int, batch: int = 32) -> np.ndarray:
    """One vector per picture from an exported model, on the processor."""
    import onnxruntime
    session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    out = []
    for start in tqdm(range(0, len(pictures), batch), desc=path.name, unit="batch", dynamic_ncols=True):
        pixels = np.stack([to_tensor(Image.open(p).convert("RGB"), resolution).numpy()
                           for p in pictures[start:start + batch]])
        out.append(session.run(None, {"pixels": pixels})[0].astype(np.float32))
    return np.concatenate(out)


def write_index(out_dir: Path, types: list[str], patterns: torch.Tensor, codes: torch.Tensor) -> None:
    """index.bin: the patterns as 32-bit numbers [parts, patterns, width], then one byte per part
    for every type's obverse, then every type's reverse. index.json says how to read it."""
    parts, count, width = patterns.shape
    with (out_dir / "index.bin").open("wb") as f:
        f.write(patterns.numpy().astype("<f4").tobytes())
        f.write(codes.numpy().astype(np.uint8).tobytes())
    (out_dir / "index.json").write_text(json.dumps(
        {"dims": parts * width, "parts": parts, "patterns": count, "types": types}))


def read_index(out_dir: Path) -> tuple[list[str], torch.Tensor]:
    """The types and the vectors their codes stand for: obverses, then reverses."""
    told = json.loads((out_dir / "index.json").read_text())
    parts, count, width = told["parts"], told["patterns"], told["dims"] // told["parts"]
    raw = (out_dir / "index.bin").read_bytes()
    cut = parts * count * width * 4
    patterns = torch.from_numpy(np.frombuffer(raw[:cut], dtype="<f4").reshape(parts, count, width).copy())
    codes = torch.from_numpy(np.frombuffer(raw[cut:], dtype=np.uint8).reshape(-1, parts).copy())
    return told["types"], index.read_back(patterns, codes)


def export(specimens: list[Specimen], views: list[View], gallery_vectors: np.ndarray, weights: Path,
           out_dir: Path, dims: int = 256, parts: int = 64, device: str | None = None,
           log=print) -> dict:
    """Write the index and the models into `out_dir` and grade each model against the index.
    `gallery_vectors` holds one row per view from the model that embeds the gallery."""
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = evaluate.complete(specimens, [(v.specimen_id, v.side) for v in views])
    gallery, held_out, _ = evaluate.split(specimens, rows)
    side = lambda i: torch.from_numpy(gallery_vectors[[rows[s.id][i] for s in gallery]].astype(np.float32))
    g_obverse, g_reverse = side(0), side(1)
    dims = min(dims, g_obverse.shape[1])

    mean, directions = index.fit_turn(torch.cat([g_obverse, g_reverse]), device)
    turn = directions[:, :dims] @ index.mixing(dims)
    made, obverse, reverse = index.keep(gallery, g_obverse, g_reverse, "mean")
    averaged = F.normalize((torch.cat([obverse, reverse]) - mean) @ turn, dim=1)
    write_index(out_dir, [s.type_id for s in made], *index.quantise(averaged, parts, device))
    types, stored = read_index(out_dir)
    assert types == [s.type_id for s in made]
    size = (out_dir / "index.bin").stat().st_size + (out_dir / "index.json").stat().st_size
    log(f"index: {len(types):,} types, {dims} numbers a side in {parts} bytes, {size / 1e6:.1f} MB")

    told = torch.load(weights, map_location="cpu", weights_only=True)["settings"]
    model = Browser(load_model(told["model"], told["resolution"], "cpu", weights), mean, turn)
    to_onnx(model, out_dir / MODELS[0][0], told["resolution"])
    halve(out_dir / MODELS[0][0], out_dir / MODELS[1][0])
    shrink_weights(out_dir / MODELS[0][0], out_dir / MODELS[2][0])

    pictures = [views[rows[s.id][i]].path for i in (0, 1) for s in held_out]
    g_rows = {s.id: (i, len(made) + i) for i, s in enumerate(made)}
    q_rows = {s.id: (i, len(held_out) + i) for i, s in enumerate(held_out)}
    graded, reference = [], None
    for name, what in MODELS:
        vectors = torch.from_numpy(run_onnx(out_dir / name, pictures, told["resolution"]))
        reference = vectors if reference is None else reference
        summary = evaluate.summary(evaluate.run(held_out, made, g_rows, stored, device,
                                                query_sets=[(q_rows, vectors)]))
        row = {"file": name, "what": what, "bytes": (out_dir / name).stat().st_size,
               "agreement": float((vectors * reference).sum(dim=1).mean()),
               "type_top1": summary["type"]["both"]["top1"], "type_top10": summary["type"]["both"]["top10"],
               "design_top10": summary["design"]["both"]["top10"]}
        graded.append(row)
        log(f"{name}: {row['bytes'] / 1e6:.1f} MB, type top 1 {100 * row['type_top1']:.1f}%, "
            f"top 10 {100 * row['type_top10']:.1f}%")
    return {"index": {"types": len(types), "dims": dims, "parts": parts, "bytes": size},
            "resolution": told["resolution"], "queries": len(held_out), "models": graded}


def markdown(report: dict) -> str:
    pct = lambda x: f"{100 * x:.1f}%"
    made = report["index"]
    out = ["# Browser export", "",
           f"Dataset {report['dataset']}. Query model `{report['query_model']}` at "
           f"{report['resolution']}px; gallery embedded by `{report['gallery_model']}`.",
           "", f"Index: {made['types']:,} types, one averaged vector a side, {made['dims']} numbers "
               f"stored in {made['parts']} bytes: {made['bytes'] / 1e6:.1f} MB (`index.bin` and `index.json`).",
           "", f"Each model embedded the {report['queries']:,} held-out coins through ONNX Runtime and "
               "searched that index. \"Agreement\" is how closely its vectors match the first row's "
               "(1 is identical).",
           "", "| File | Model | Size | Agreement | Type top 1 | Type top 10 | Design top 10 |",
           "|---|---|---|---|---|---|---|"]
    for row in report["models"]:
        out.append(f"| `{row['file']}` | {row['what']} | {row['bytes'] / 1e6:.1f} MB | "
                   f"{row['agreement']:.4f} | {pct(row['type_top1'])} | {pct(row['type_top10'])} | "
                   f"{pct(row['design_top10'])} |")
    return "\n".join(out) + "\n"
