"""Turn each side of each coin into a vector with a vision model.

The baseline model is DINOv2 (small, with registers) exactly as published; a trained model is the
same network with its own weights. Vectors are saved a block at a time, so a run that stops can
pick up where it left off, and a full graphics card makes the batch smaller rather than ending
the run.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import timm
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

from . import crop, resources
from .crops import View

MODEL = "vit_small_patch14_reg4_dinov2.lvd142m"
RESOLUTION = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
BLOCK = 16384          # views per saved file
MIN_BATCH = 1


class Projected(torch.nn.Module):
    """A network followed by one linear layer. A distilled student is this: the layer maps its
    vectors into its teacher's space, so the two models' vectors can be compared."""

    def __init__(self, backbone: torch.nn.Module, head: torch.nn.Linear) -> None:
        super().__init__()
        self.backbone, self.head = backbone, head

    def forward(self, pixels: torch.Tensor) -> torch.Tensor:
        return self.head(self.backbone(pixels))


def load_model(model_name: str, resolution: int, device: str, weights: Path | None = None):
    """The network, with the published weights or those saved by `train` (including, for a
    distilled student, the layer into its teacher's space)."""
    model = timm.create_model(model_name, pretrained=weights is None, num_classes=0, img_size=resolution)
    if weights is not None:
        saved = torch.load(weights, map_location="cpu", weights_only=True)
        model.load_state_dict(saved["backbone"])
        if "head" in saved:
            head = torch.nn.Linear(*reversed(saved["head"]["weight"].shape))
            head.load_state_dict(saved["head"])
            model = Projected(model, head)
    return model.eval().to(device)


def variant(picture: Image.Image, gray: bool = False, angle: int = 0) -> Image.Image:
    """A crop with its colour removed or turned by `angle` degrees (the corners fill with the
    background colour), for the diagnostics."""
    if gray:
        picture = picture.convert("L").convert("RGB")
    if angle:
        picture = picture.rotate(angle, resample=Image.Resampling.BICUBIC,
                                 fillcolor=picture.getpixel((0, 0)))
    return picture


def to_tensor(picture: Image.Image, resolution: int) -> torch.Tensor:
    if picture.size != (resolution, resolution):
        picture = picture.resize((resolution, resolution), Image.Resampling.BICUBIC)
    pixels = (np.asarray(picture, dtype=np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(pixels.transpose(2, 0, 1).copy())


class _Crops(Dataset):
    def __init__(self, paths: list[str], resolution: int, gray: bool, angle: int) -> None:
        self.paths, self.resolution, self.gray, self.angle = paths, resolution, gray, angle

    def __len__(self) -> int:
        return len(self.paths)

    def __getitem__(self, i: int) -> torch.Tensor:
        picture = Image.open(self.paths[i]).convert("RGB")
        return to_tensor(variant(picture, self.gray, self.angle), self.resolution)


def _blocks(model, paths: list[str], first: int, resolution: int, gray: bool, angle: int,
            batch_size: int, device: str, workers: int, bar):
    """Embed paths[first * BLOCK:] in order, yielding (block number, vectors) as each fills."""
    loader = DataLoader(_Crops(paths[first * BLOCK:], resolution, gray, angle), batch_size=batch_size,
                        num_workers=workers)
    pending: list[np.ndarray] = []
    held, block = 0, first
    with torch.inference_mode():
        for pixels in loader:
            with torch.autocast("cuda", enabled=device == "cuda"):
                vectors = model(pixels.to(device))
            vectors = torch.nn.functional.normalize(vectors.float(), dim=1)
            pending.append(vectors.cpu().numpy().astype(np.float16))
            held += len(pixels)
            bar.update(len(pixels))
            while held >= BLOCK:
                joined = np.concatenate(pending)
                yield block, joined[:BLOCK]
                pending, held, block = [joined[BLOCK:]], held - BLOCK, block + 1
    if held:
        yield block, np.concatenate(pending)


def embed(views: list[View], data_dir: Path, tag: str | None = None, model=None,
          model_name: str = MODEL, weights: Path | None = None, resolution: int = RESOLUTION,
          batch_size: int = 256, device: str | None = None, workers: int | None = None,
          gray: bool = False, angle: int = 0, log=print) -> np.ndarray:
    """One unit vector per view, in the order given. Kept in data/embeddings/<tag>/ and reused.

    Pass `model` to use a network already in memory (training does); otherwise `model_name` is
    loaded, with `weights` if given. `gray` and `angle` embed a variant of each picture."""
    tag = (tag or model_name) + f"-{resolution}" + ("-gray" if gray else "") + (f"-rot{angle}" if angle else "")
    out_dir = data_dir / "embeddings" / tag
    paths = [str(v.path) for v in views]
    fingerprint = hashlib.sha1("\n".join(
        [f"{crop.VERSION}/{BLOCK}/{weights}"] + [f"{v.specimen_id}/{v.side}/{v.path.name}" for v in views]
    ).encode()).hexdigest()
    meta = out_dir / "meta.json"
    if not meta.exists() or json.loads(meta.read_text())["fingerprint"] != fingerprint:
        shutil.rmtree(out_dir, ignore_errors=True)       # vectors for other pictures or settings
        out_dir.mkdir(parents=True)
        meta.write_text(json.dumps({"fingerprint": fingerprint, "views": len(views)}))
    total = (len(paths) + BLOCK - 1) // BLOCK

    def block_path(i: int) -> Path:
        return out_dir / f"block-{i:04d}.npy"

    first = next((i for i in range(total) if not block_path(i).exists()), total)
    if first < total:
        device = device or resources.pick_device()
        n = resources.workers(workers)
        log(f"embedding {len(paths) - first * BLOCK:,} views ({tag}) on {device}, "
            f"batch {batch_size}, {n} helper processes"
            + (f"; {first * BLOCK:,} already done" if first else ""))
        if model is None:
            model = load_model(model_name, resolution, device, weights)
        model.eval()
        with tqdm(total=len(paths), initial=first * BLOCK, unit="view", smoothing=0, dynamic_ncols=True) as bar:
            while first < total:
                try:
                    for block, vectors in _blocks(model, paths, first, resolution, gray, angle,
                                                  batch_size, device, n, bar):
                        partial = block_path(block).with_suffix(".part")
                        with partial.open("wb") as f:
                            np.save(f, vectors)
                        partial.replace(block_path(block))
                        first = block + 1
                except Exception as error:   # out of memory: carry on from this block with less
                    if not resources.is_out_of_memory(error) or batch_size <= MIN_BATCH:
                        raise
                    batch_size //= 2
                    resources.release()
                    bar.n = first * BLOCK
                    bar.write(f"out of memory: continuing with batch {batch_size}")
    if not total:
        return np.zeros((0, 0), dtype=np.float16)
    return np.concatenate([np.load(block_path(i)) for i in range(total)])
