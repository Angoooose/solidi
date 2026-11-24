"""Turn each side of each coin into a vector with a pretrained vision model.

The baseline model is DINOv2 (small, with registers), exactly as published: nothing here is
trained. A "view" is one side of one specimen; a picture showing both sides gives two views.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import timm
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset

from .crop import crop_coin, split_combined
from .download import image_path
from .records import Specimen

MODEL = "vit_small_patch14_reg4_dinov2.lvd142m"
RESOLUTION = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _tensor(picture: Image.Image, resolution: int) -> torch.Tensor:
    picture = crop_coin(picture).resize((resolution, resolution), Image.Resampling.BICUBIC)
    pixels = (np.asarray(picture, dtype=np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(pixels.transpose(2, 0, 1).copy())


class _Photos(Dataset):
    """One item per photo file: its views as tensors. Unreadable files give no views."""

    def __init__(self, items: list[tuple[str, str, Path]], resolution: int) -> None:
        self.items, self.resolution = items, resolution

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        specimen_id, side, path = self.items[i]
        try:
            picture = Image.open(path).convert("RGB")
        except OSError:
            return []
        if side != "combined":
            return [(specimen_id, side, _tensor(picture, self.resolution))]
        halves = split_combined(picture)
        if halves is None:
            return []
        return [(specimen_id, name, _tensor(half, self.resolution))
                for name, half in zip(("obverse", "reverse"), halves)]


def _collate(batch):
    views = [view for item in batch for view in item]
    if not views:
        return [], None
    return [(sid, side) for sid, side, _ in views], torch.stack([t for _, _, t in views])


def embed(specimens: list[Specimen], data_dir: Path, model_name: str = MODEL,
          resolution: int = RESOLUTION, batch_size: int = 256, device: str | None = None,
          workers: int = 4, log=print) -> tuple[list[tuple[str, str]], np.ndarray]:
    """Embed every downloaded photo. Returns the views [(specimen id, side)] and their unit
    vectors, one row each. Results are kept in data/embeddings/ and reused."""
    images_dir = data_dir / "images"
    items = [(s.id, p.side, image_path(images_dir, p.key)) for s in specimens for p in s.photos]
    items = [item for item in items if item[2].exists()]
    out_dir = data_dir / "embeddings" / f"{model_name}-{resolution}"
    wanted = sorted(f"{sid}/{side}" for sid, side, _ in items)
    if (out_dir / "views.json").exists():
        saved = json.loads((out_dir / "views.json").read_text())
        if saved["photos"] == wanted:
            log(f"reusing embeddings in {out_dir}")
            return [tuple(v) for v in saved["views"]], np.load(out_dir / "vectors.npy")

    device = device or pick_device()
    log(f"embedding {len(items):,} photos with {model_name} at {resolution}px on {device}")
    model = timm.create_model(model_name, pretrained=True, num_classes=0, img_size=resolution)
    model = model.eval().to(device)
    loader = DataLoader(_Photos(items, resolution), batch_size=batch_size, num_workers=workers,
                        collate_fn=_collate)
    views: list[tuple[str, str]] = []
    chunks: list[np.ndarray] = []
    with torch.inference_mode():
        for n, (batch_views, pixels) in enumerate(loader):
            if pixels is None:
                continue
            with torch.autocast("cuda", enabled=device == "cuda"):
                vectors = model(pixels.to(device))
            vectors = torch.nn.functional.normalize(vectors.float(), dim=1)
            views += batch_views
            chunks.append(vectors.cpu().numpy().astype(np.float16))
            if n % 50 == 49:
                log(f"  {len(views):,} views")
    vectors = np.concatenate(chunks) if chunks else np.zeros((0, 0), dtype=np.float16)
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / "vectors.npy", vectors)
    (out_dir / "views.json").write_text(json.dumps({"photos": wanted, "views": views}))
    return views, vectors
