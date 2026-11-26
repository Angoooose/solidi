"""Fine-tune the vision model so that pictures of the same coin design land close together.

Training uses only the gallery collections. Each side of each coin is a training picture, labelled
with everything recorded about that side (records.side_key). The model learns to place a picture
near its label's centre and away from the others (a CosFace loss), with smaller side tasks that
ask the same vector to predict the portrait, denomination and mint.

Pictures are changed at random as they are shown (turned, re-lit, blurred, zoomed) so the model
cannot lean on one museum's way of photographing.

After every pass the model is graded exactly as the baseline is, on the held-out collections.
Everything needed to continue is saved every few minutes and after each pass, so running the same
command again resumes; if the graphics card fills up, the batch is halved and training carries on.
"""

from __future__ import annotations

import json
import math
import random
import shutil
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

import torch
from PIL import Image
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision.transforms import v2
from tqdm import tqdm

from . import crops, evaluate, resources
from .embed import MODEL, RESOLUTION, embed, load_model, to_tensor
from .records import Specimen

AUX = ("portrait", "denomination", "mint")
SAVE_EVERY = 600        # seconds between saves within a pass
MIN_BATCH = 8


@dataclass
class Settings:
    model: str = MODEL
    resolution: int = RESOLUTION
    epochs: int = 8
    batch_size: int = 128
    lr: float = 2e-5            # the pretrained network: small steps, so it keeps what it knows
    head_lr: float = 5e-3       # the new label centres and side tasks: they start from nothing
    weight_decay: float = 0.05
    warmup: float = 0.03        # share of training spent ramping the step size up
    margin: float = 0.35        # CosFace: how far a picture must clear the other labels
    scale: float = 30.0
    aux_weight: float = 0.2     # weight of each side task next to the main loss
    seed: int = 0


class _Pictures(Dataset):
    """Training pictures, changed at random each time they are shown. No mirror flip: which way
    a portrait faces, and the lettering, are part of the design."""

    def __init__(self, items: list[tuple], resolution: int) -> None:
        self.items, self.resolution = items, resolution
        self.change = v2.Compose([
            v2.RandomResizedCrop(resolution, scale=(0.6, 1.0), ratio=(0.9, 1.1), antialias=True),
            v2.RandomApply([v2.RandomPerspective(distortion_scale=0.15, p=1.0)], p=0.3),
            v2.ColorJitter(brightness=0.4, contrast=0.4, saturation=0.4, hue=0.03),
            v2.RandomGrayscale(p=0.25),
            v2.RandomApply([v2.GaussianBlur(kernel_size=5, sigma=(0.1, 2.0))], p=0.3),
        ])

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        path, label, *aux = self.items[i]
        picture = Image.open(path).convert("RGB")
        picture = picture.rotate(random.uniform(0, 360), resample=Image.Resampling.BICUBIC,
                                 fillcolor=picture.getpixel((0, 0)))
        return to_tensor(self.change(picture), self.resolution), label, torch.tensor(aux)


class _Heads(nn.Module):
    """What sits on top of the network during training only: one centre per label, and a small
    predictor for each side task."""

    def __init__(self, dim: int, labels: int, aux: dict[str, int]) -> None:
        super().__init__()
        self.centres = nn.Parameter(torch.randn(labels, dim) * 0.01)
        self.aux = nn.ModuleDict({name: nn.Linear(dim, n) for name, n in aux.items() if n})

    def loss(self, vectors: torch.Tensor, labels: torch.Tensor, aux: torch.Tensor, s: Settings):
        cosine = vectors @ F.normalize(self.centres, dim=1).T
        cosine = cosine - s.margin * F.one_hot(labels, cosine.shape[1])
        total = F.cross_entropy(s.scale * cosine, labels)
        for name in self.aux:
            i = AUX.index(name)
            if (aux[:, i] >= 0).any():
                total = total + s.aux_weight * F.cross_entropy(self.aux[name](vectors), aux[:, i],
                                                               ignore_index=-1)
        return total


def _training_items(specimens: list[Specimen], views: list[crops.View]):
    """One item per gallery view: (path, label, portrait, denomination, mint), with -1 where a
    side task has no answer. The portrait is asked of obverses only."""
    by_id = {s.id: s for s in specimens if not s.held_out}
    views = [v for v in views if v.specimen_id in by_id]
    label_of = lambda v: getattr(by_id[v.specimen_id], f"{v.side}_class")
    labels = {name: i for i, name in enumerate(sorted({label_of(v) for v in views}))}
    aux = {name: {value: i for i, value in enumerate(sorted(
        {s.label(name) for s in by_id.values() if s.label(name)}))} for name in AUX}
    items = []
    for v in views:
        s = by_id[v.specimen_id]
        answers = [aux[name].get(s.label(name), -1) for name in AUX]
        if v.side != "obverse":
            answers[0] = -1
        items.append((str(v.path), labels[label_of(v)], *answers))
    return items, len(labels), {name: len(values) for name, values in aux.items()}


def _loader(items, settings: Settings, batch_size: int, workers: int, count: int) -> DataLoader:
    """`count` pictures drawn at random. A label with many pictures is drawn less often per
    picture (by the square root of its size), so a few heavily photographed designs don't crowd
    out the rest."""
    per_label = Counter(item[1] for item in items)
    weights = [per_label[item[1]] ** -0.5 for item in items]
    sampler = WeightedRandomSampler(weights, num_samples=max(count, batch_size), replacement=True)
    return DataLoader(_Pictures(items, settings.resolution), batch_size=batch_size, sampler=sampler,
                      num_workers=workers, drop_last=True, persistent_workers=False)


def _step_size(progress: float, warmup: float) -> float:
    """The share of the full step size at this point: ramp up, then ease down to zero."""
    if progress < warmup:
        return progress / warmup
    return 0.5 * (1 + math.cos(math.pi * min(1.0, (progress - warmup) / (1 - warmup))))


def _save(path: Path, state: dict) -> None:
    partial = path.with_suffix(".part")
    torch.save(state, partial)
    partial.replace(path)


def _grade(model, specimens, views, data_dir: Path, tag: str, device: str, workers, batch_size, log) -> dict:
    vectors = embed(views, data_dir, tag=tag, model=model, device=device, workers=workers,
                    batch_size=max(batch_size, 64), log=log)
    report = evaluate.evaluate(specimens, [(v.specimen_id, v.side) for v in views], vectors, log=log)
    return {test: {"type_top1": report[test]["type"]["both"]["top1"],
                   "type_top10": report[test]["type"]["both"]["top10"],
                   "type_top100": report[test]["type"]["both"]["top100"],
                   "design_top10": report[test]["design"]["both"]["top10"],
                   "portrait": report[test]["labels"].get("portrait", {}).get("top1")}
            for test in ("held_out", "same_collection") if report[test]["queries"]}


def markdown(name: str, settings: Settings, history: list[dict]) -> str:
    pct = lambda x: "n/a" if x is None else f"{100 * x:.1f}%"
    out = [f"# Training run `{name}`", "",
           f"{settings.model} at {settings.resolution}px. Pass 0 is the model before any training.",
           "", "| Pass | Loss | Held-out type top 1 | Held-out type top 10 | Held-out design top 10 | "
               "Held-out portrait | Same-museum type top 10 |", "|---|---|---|---|---|---|---|"]
    for row in history:
        held, same = row.get("held_out", {}), row.get("same_collection", {})
        loss = "" if row.get("loss") is None else f"{row['loss']:.3f}"
        out.append(f"| {row['epoch']} | {loss} | {pct(held.get('type_top1'))} | "
                   f"{pct(held.get('type_top10'))} | {pct(held.get('design_top10'))} | "
                   f"{pct(held.get('portrait'))} | {pct(same.get('type_top10'))} |")
    return "\n".join(out) + "\n"


def train(specimens: list[Specimen], data_dir: Path, run_dir: Path, settings: Settings,
          device: str | None = None, workers: int | None = None, batch_size: int | None = None,
          log=print) -> list[dict]:
    """`batch_size`, when given, replaces the one in `settings` and the one a resumed run saved."""
    device = device or resources.pick_device()
    resources.cap_gpu_memory(device)
    if batch_size:
        settings.batch_size = batch_size
    run_dir.mkdir(parents=True, exist_ok=True)
    views = crops.prepare(specimens, data_dir, workers, log=log)
    items, n_labels, aux_sizes = _training_items(specimens, views)
    log(f"{len(items):,} training pictures, {n_labels:,} labels; "
        + ", ".join(f"{n:,} {name}s" for name, n in aux_sizes.items()))

    torch.manual_seed(settings.seed)
    random.seed(settings.seed)
    model = load_model(settings.model, settings.resolution, device)
    heads = _Heads(model.num_features, n_labels, aux_sizes).to(device)
    optimiser = torch.optim.AdamW([
        {"params": model.parameters(), "lr": settings.lr, "weight_decay": settings.weight_decay},
        {"params": heads.parameters(), "lr": settings.head_lr, "weight_decay": 0.0}])
    full_steps = [group["lr"] for group in optimiser.param_groups]
    scaler = torch.amp.GradScaler("cuda", enabled=device == "cuda")
    state = {"epoch": 0, "seen": 0, "batch_size": settings.batch_size, "history": [], "best": -1.0,
             "loss_sum": 0.0, "loss_count": 0}

    last = run_dir / "last.pt"
    if last.exists():
        saved = torch.load(last, map_location="cpu", weights_only=False)
        if saved["labels"] != n_labels or saved["settings"]["model"] != settings.model:
            raise SystemExit(f"{last} was made with different data or another model; "
                             "use a new --name or delete the folder")
        model.load_state_dict(saved["backbone"])
        heads.load_state_dict(saved["heads"])
        optimiser.load_state_dict(saved["optimiser"])
        scaler.load_state_dict(saved["scaler"])
        state = saved["state"]
        if batch_size:
            state["batch_size"] = batch_size
        log(f"resuming {run_dir.name}: pass {state['epoch'] + 1}, "
            f"{state['seen']:,} of {len(items):,} pictures in, batch {state['batch_size']}")

    def save() -> None:
        _save(last, {"backbone": model.state_dict(), "heads": heads.state_dict(),
                     "optimiser": optimiser.state_dict(), "scaler": scaler.state_dict(),
                     "state": state, "labels": n_labels, "settings": asdict(settings)})

    def grade(epoch: int, loss: float | None) -> None:
        tag = f"{run_dir.name}-pass{epoch}"
        result = _grade(model, specimens, views, data_dir, tag, device, workers, state["batch_size"], log)
        state["history"].append({"epoch": epoch, "loss": loss, **result})
        # The best pass is the one with the highest top 1 and top 10 together: top 10 alone
        # barely moves late in training, and picked an early pass on a two-coin difference.
        graded = result.get("held_out", result.get("same_collection", {}))
        score = graded.get("type_top1", 0.0) + graded.get("type_top10", 0.0)
        if score > state["best"]:
            state["best"] = score
            _save(run_dir / "best.pt", {"backbone": model.state_dict(), "epoch": epoch,
                                         "settings": asdict(settings)})
        shutil.rmtree(data_dir / "embeddings" / f"{tag}-{settings.resolution}", ignore_errors=True)
        (run_dir / "history.json").write_text(json.dumps(state["history"], indent=2))
        (run_dir / "report.md").write_text(markdown(run_dir.name, settings, state["history"]))
        held = result.get("held_out", {})
        log(f"pass {epoch}: held-out type top 10 {100 * held.get('type_top10', 0):.1f}%, "
            f"design top 10 {100 * held.get('design_top10', 0):.1f}%")

    if not state["history"]:
        grade(0, None)       # the bar to beat, measured the same way
        save()
    elif state["history"][-1]["epoch"] < state["epoch"]:
        # stopped while grading: the last pass was trained and saved but never scored
        log(f"pass {state['epoch']} was trained but not graded; grading it now")
        grade(state["epoch"], None)    # its average loss was not kept
        save()

    total = settings.epochs * len(items)
    n_workers = resources.workers(workers)
    log(f"training on {device}: {settings.epochs} passes, batch {state['batch_size']}, "
        f"{n_workers} helper processes")
    while state["epoch"] < settings.epochs:
        model.train()
        saved_at = time.monotonic()
        try:
            loader = _loader(items, settings, state["batch_size"], n_workers, len(items) - state["seen"])
            with tqdm(total=len(items), initial=state["seen"], unit="pic", smoothing=0.05, dynamic_ncols=True,
                      desc=f"pass {state['epoch'] + 1}/{settings.epochs}") as bar:
                for pixels, labels, aux in loader:
                    share = _step_size((state["epoch"] * len(items) + state["seen"]) / total, settings.warmup)
                    for group, full in zip(optimiser.param_groups, full_steps):
                        group["lr"] = full * share
                    pixels, labels, aux = pixels.to(device), labels.to(device), aux.to(device)
                    with torch.autocast("cuda", enabled=device == "cuda"):
                        vectors = model(pixels)
                    loss = heads.loss(F.normalize(vectors.float(), dim=1), labels, aux, settings)
                    optimiser.zero_grad(set_to_none=True)
                    scaler.scale(loss).backward()
                    scaler.unscale_(optimiser)
                    nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    scaler.step(optimiser)
                    scaler.update()
                    state["seen"] += len(pixels)
                    state["loss_sum"] += loss.item()
                    state["loss_count"] += 1
                    bar.update(len(pixels))
                    bar.set_postfix(loss=f"{state['loss_sum'] / state['loss_count']:.3f}", refresh=False)
                    if time.monotonic() - saved_at > SAVE_EVERY:
                        save()
                        saved_at = time.monotonic()
        except Exception as error:   # out of memory: halve the batch and carry on with this pass
            if not resources.is_out_of_memory(error) or state["batch_size"] <= MIN_BATCH:
                raise
            del loader
            optimiser.zero_grad(set_to_none=True)
            resources.release()
            state["batch_size"] //= 2
            log(f"out of memory: continuing with batch {state['batch_size']}")
            continue
        state["epoch"] += 1
        loss = state["loss_sum"] / max(1, state["loss_count"])
        state.update(seen=0, loss_sum=0.0, loss_count=0)
        save()               # the pass is safe before the slow grading starts
        grade(state["epoch"], loss)
        save()
    log(f"done: best weights in {run_dir / 'best.pt'}, report in {run_dir / 'report.md'}")
    return state["history"]
