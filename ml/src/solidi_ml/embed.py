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

from . import crop
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


def views_of(picture: Image.Image, side: str) -> list[tuple[str, Image.Image]]:
    """The sides a photo shows, as (side, picture). A 'combined' photo is cut in two; one that
    isn't laid out as two sides gives nothing."""
    if side != "combined":
        return [(side, picture)]
    halves = split_combined(picture)
    return list(zip(("obverse", "reverse"), halves)) if halves else []


def prepare(picture: Image.Image, gray: bool = False, angle: int = 0) -> tuple[Image.Image, bool]:
    """The square picture the model is shown, and whether the coin was found in it: the coin cut
    out, then optionally with its colour removed or turned by `angle` degrees (the corners fill
    with the background colour)."""
    picture, found = crop_coin(picture)
    if gray:
        picture = picture.convert("L").convert("RGB")
    if angle:
        picture = picture.rotate(angle, resample=Image.Resampling.BICUBIC,
                                 fillcolor=picture.getpixel((0, 0)))
    return picture, found


def _tensor(picture: Image.Image, resolution: int) -> torch.Tensor:
    picture = picture.resize((resolution, resolution), Image.Resampling.BICUBIC)
    pixels = (np.asarray(picture, dtype=np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(pixels.transpose(2, 0, 1).copy())


class _Photos(Dataset):
    """One item per photo file: its views as tensors. Unreadable files give no views."""

    def __init__(self, items: list[tuple[str, str, Path]], resolution: int, gray: bool,
                 angle: int) -> None:
        self.items, self.resolution, self.gray, self.angle = items, resolution, gray, angle

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        specimen_id, side, path = self.items[i]
        try:
            picture = Image.open(path).convert("RGB")
        except OSError:
            return []
        out = []
        for name, view in views_of(picture, side):
            prepared, found = prepare(view, self.gray, self.angle)
            out.append((specimen_id, name, found, _tensor(prepared, self.resolution)))
        return out


def _collate(batch):
    views = [view for item in batch for view in item]
    if not views:
        return [], [], None
    return ([(sid, side) for sid, side, _, _ in views], [found for _, _, found, _ in views],
            torch.stack([t for *_, t in views]))


def embed(specimens: list[Specimen], data_dir: Path, model_name: str = MODEL,
          resolution: int = RESOLUTION, batch_size: int = 256, device: str | None = None,
          workers: int = 4, log=print, gray: bool = False,
          angle: int = 0) -> tuple[list[tuple[str, str]], np.ndarray, list[bool]]:
    """Embed every downloaded photo. Returns the views [(specimen id, side)], their unit vectors
    (one row each) and whether the coin was found in each. Results are kept in data/embeddings/
    and reused.

    `gray` and `angle` embed a variant of each picture (see `prepare`), kept separately."""
    images_dir = data_dir / "images"
    items = [(s.id, p.side, image_path(images_dir, p.key)) for s in specimens for p in s.photos]
    items = [item for item in items if item[2].exists()]
    variant = ("-gray" if gray else "") + (f"-rot{angle}" if angle else "")
    out_dir = data_dir / "embeddings" / f"{model_name}-{resolution}{variant}"
    wanted = sorted(f"{sid}/{side}" for sid, side, _ in items)
    if (out_dir / "views.json").exists():
        saved = json.loads((out_dir / "views.json").read_text())
        if saved["photos"] == wanted and saved.get("crop") == crop.VERSION:
            log(f"reusing embeddings in {out_dir}")
            return [tuple(v) for v in saved["views"]], np.load(out_dir / "vectors.npy"), saved["found"]

    device = device or pick_device()
    log(f"embedding {len(items):,} photos with {model_name} at {resolution}px on {device}"
        + (", greyscale" if gray else "") + (f", turned {angle} degrees" if angle else ""))
    model = timm.create_model(model_name, pretrained=True, num_classes=0, img_size=resolution)
    model = model.eval().to(device)
    loader = DataLoader(_Photos(items, resolution, gray, angle), batch_size=batch_size, num_workers=workers,
                        collate_fn=_collate)
    views: list[tuple[str, str]] = []
    found: list[bool] = []
    chunks: list[np.ndarray] = []
    with torch.inference_mode():
        for n, (batch_views, batch_found, pixels) in enumerate(loader):
            if pixels is None:
                continue
            with torch.autocast("cuda", enabled=device == "cuda"):
                vectors = model(pixels.to(device))
            vectors = torch.nn.functional.normalize(vectors.float(), dim=1)
            views += batch_views
            found += batch_found
            chunks.append(vectors.cpu().numpy().astype(np.float16))
            if n % 50 == 49:
                log(f"  {len(views):,} views")
    vectors = np.concatenate(chunks) if chunks else np.zeros((0, 0), dtype=np.float16)
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / "vectors.npy", vectors)
    (out_dir / "views.json").write_text(json.dumps(
        {"photos": wanted, "crop": crop.VERSION, "views": views, "found": found}))
    return views, vectors, found
