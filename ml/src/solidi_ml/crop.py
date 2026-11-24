"""Cut each photo down to the coin, so the model looks at the coin and not the background.

Museum photos put a coin on a plain background. We take the background colour from the edge of
the picture, find the box of pixels that differ from it, and pad that box to a square. When that
doesn't find one plausible coin (a busy background, a clipping from a printed page), the picture
is used whole.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

DIFFERENCE = 36        # summed RGB distance from the background that counts as "coin"
MIN_FILL = 0.02        # a row or column is part of the coin if this share of it differs
MIN_AREA = 0.03        # a box smaller than this share of the picture is not trusted
MARGIN = 0.04          # breathing room around the coin, as a share of its size
SPLIT_RATIO = 1.4      # a 'combined' picture this much wider than tall is two sides side by side


def _background(pixels: np.ndarray) -> np.ndarray:
    h, w, _ = pixels.shape
    b = max(2, min(h, w) // 50)
    edge = np.concatenate([pixels[:b].reshape(-1, 3), pixels[-b:].reshape(-1, 3),
                           pixels[:, :b].reshape(-1, 3), pixels[:, -b:].reshape(-1, 3)])
    return np.median(edge, axis=0)


def crop_coin(picture: Image.Image) -> Image.Image:
    """The coin as a square picture, on its own background colour."""
    picture = picture.convert("RGB")
    pixels = np.asarray(picture, dtype=np.int16)
    h, w, _ = pixels.shape
    background = _background(pixels)
    differs = np.abs(pixels - background).sum(axis=2) > DIFFERENCE
    rows = np.flatnonzero(differs.mean(axis=1) > MIN_FILL)
    cols = np.flatnonzero(differs.mean(axis=0) > MIN_FILL)
    if rows.size and cols.size:
        top, bottom, left, right = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
        if (bottom - top) * (right - left) >= MIN_AREA * h * w:
            picture = picture.crop((left, top, right, bottom))
    cw, ch = picture.size
    side = round(max(cw, ch) * (1 + 2 * MARGIN))
    square = Image.new("RGB", (side, side), tuple(int(c) for c in background))
    square.paste(picture, ((side - cw) // 2, (side - ch) // 2))
    return square


def split_combined(picture: Image.Image) -> tuple[Image.Image, Image.Image] | None:
    """The two halves of a picture showing both sides, obverse first, or None if it isn't laid
    out as two sides in a row or a column. Assumes the usual order: obverse left or on top."""
    w, h = picture.size
    if w >= SPLIT_RATIO * h:
        return picture.crop((0, 0, w // 2, h)), picture.crop((w // 2, 0, w, h))
    if h >= SPLIT_RATIO * w:
        return picture.crop((0, 0, w, h // 2)), picture.crop((0, h // 2, w, h))
    return None
