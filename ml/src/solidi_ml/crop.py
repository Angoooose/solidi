"""Cut each photo down to the coin, so the model looks at the coin and not the background.

The coin is taken to be the largest roundish object that stands out from the background. Museum
backgrounds vary: plain white, a textured card, a cutting mat with grid lines, a ruler alongside.
So the picture is blurred a little before measuring (texture and thin lines fade, the coin
doesn't), thin leftovers are rubbed out, and what remains is judged by how well it fills a circle.
When no such object is found the picture is used whole.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

VERSION = 2            # bump when the result changes, so stored vectors are recomputed
WORK = 256             # the longer side of the copy the coin is looked for in
MIN_DIFFERENCE = 24    # summed RGB distance from the background that can count as "coin"
MIN_AREA = 0.015       # an object smaller than this share of the picture is ignored
MIN_ROUND = 0.5        # share of its enclosing circle an object must fill to be a coin
MARGIN = 0.04          # breathing room around the coin, as a share of its size
SPLIT_RATIO = 1.4      # a 'combined' picture this much wider than tall is two sides side by side


def _background(pixels: np.ndarray) -> np.ndarray:
    h, w, _ = pixels.shape
    b = max(2, min(h, w) // 50)
    edge = np.concatenate([pixels[:b].reshape(-1, 3), pixels[-b:].reshape(-1, 3),
                           pixels[:, :b].reshape(-1, 3), pixels[:, -b:].reshape(-1, 3)])
    return np.median(edge, axis=0)


def find_coin(picture: Image.Image) -> tuple[int, int, int, int] | None:
    """The coin's box (left, top, right, bottom) in the picture, or None if nothing in it looks
    like one coin."""
    w, h = picture.size
    scale = WORK / max(w, h)
    small = picture.convert("RGB").resize((max(8, round(w * scale)), max(8, round(h * scale))),
                                          Image.Resampling.BILINEAR)
    pixels = cv2.GaussianBlur(np.asarray(small), (0, 0), sigmaX=WORK / 100).astype(np.int16)
    distance = np.abs(pixels - _background(pixels)).sum(axis=2).clip(0, 255).astype(np.uint8)
    threshold, _ = cv2.threshold(distance, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = (distance > max(threshold, MIN_DIFFERENCE)).astype(np.uint8)
    brush = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (WORK // 24, WORK // 24))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, brush)     # rub out grid lines and specks
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, brush)    # fill small holes in the coin
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best, best_score = None, 0.0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < MIN_AREA * mask.size:
            continue
        _, radius = cv2.minEnclosingCircle(contour)
        roundness = area / (np.pi * radius * radius + 1e-6)
        if roundness >= MIN_ROUND and area * roundness > best_score:
            best, best_score = contour, area * roundness
    if best is None:
        return None
    x, y, bw, bh = cv2.boundingRect(best)
    return (int(x / scale), int(y / scale), min(w, round((x + bw) / scale)), min(h, round((y + bh) / scale)))


def crop_coin(picture: Image.Image) -> tuple[Image.Image, bool]:
    """The coin as a square picture on the background colour, and whether a coin was found (if
    not, the square holds the whole picture)."""
    picture = picture.convert("RGB")
    background = _background(np.asarray(picture, dtype=np.int16))
    box = find_coin(picture)
    if box:
        picture = picture.crop(box)
    cw, ch = picture.size
    side = round(max(cw, ch) * (1 + 2 * MARGIN))
    square = Image.new("RGB", (side, side), tuple(int(c) for c in background))
    square.paste(picture, ((side - cw) // 2, (side - ch) // 2))
    return square, box is not None


def views_of(picture: Image.Image, side: str) -> list[tuple[str, Image.Image]]:
    """The sides a photo shows, as (side, picture). A 'combined' photo is cut in two; one that
    isn't laid out as two sides gives nothing."""
    if side != "combined":
        return [(side, picture)]
    halves = split_combined(picture)
    return list(zip(("obverse", "reverse"), halves)) if halves else []


def split_combined(picture: Image.Image) -> tuple[Image.Image, Image.Image] | None:
    """The two halves of a picture showing both sides, obverse first, or None if it isn't laid
    out as two sides in a row or a column. Assumes the usual order: obverse left or on top."""
    w, h = picture.size
    if w >= SPLIT_RATIO * h:
        return picture.crop((0, 0, w // 2, h)), picture.crop((w // 2, 0, w, h))
    if h >= SPLIT_RATIO * w:
        return picture.crop((0, 0, w, h // 2)), picture.crop((0, h // 2, w, h))
    return None
