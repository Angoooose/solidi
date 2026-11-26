"""Teach a small model to answer like a large one, so the two can share one search.

The teacher is a large model already fine-tuned by `train`. It embeds the gallery, offline. The
student is the small model a browser can run; it embeds only the user's photo. For that to work
the student's vectors must land where the teacher's would, so the student is trained on two
things, following the published work on asymmetric retrieval:

- agree with the teacher on each picture: its vector should point the same way as the teacher's
  vector for the same picture (Budnik & Avrithis, "Asymmetric metric learning", 2021);
- agree with the teacher on the neighbourhood: measured against the gallery coins the teacher
  finds nearest, the student should rank them as the teacher does (Wu et al., "Contextual
  similarity distillation", 2022).

Teacher and student are shown the same randomly changed picture, each at its own size; changing
them differently teaches the student worse than not changing them at all (Suma & Tolias, 2023).
No labels are used. A single linear layer on the student maps its vectors to the teacher's width.

Each pass is graded three ways on the held-out collections: the student searching the teacher's
gallery (how it will be used), the student alone, and, once, the teacher alone.
"""

from __future__ import annotations

import json
import random
import shutil
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from tqdm import tqdm

from . import crops, evaluate, resources
from .embed import MODEL, RESOLUTION, Projected, embed, load_model, to_tensor
from .records import Specimen
from .train import MIN_BATCH, SAVE_EVERY, _save, _step_size, augmentation, turned


@dataclass
class Settings:
    teacher: str = ""               # the teacher's weights: a best.pt written by `train`
    init: str = ""                  # weights the student starts from (default: the published ones)
    model: str = MODEL
    resolution: int = RESOLUTION
    epochs: int = 8
    batch_size: int = 128
    lr: float = 2e-5
    head_lr: float = 1e-3           # the new layer into the teacher's space
    weight_decay: float = 0.05
    warmup: float = 0.03
    neighbours: int = 1024          # gallery coins each picture is measured against
    teacher_temperature: float = 0.01   # sharp: the teacher's nearest few carry the weight
    student_temperature: float = 1.0
    feature_weight: float = 1.0
    context_weight: float = 1.0
    cached_teacher: bool = False    # use the teacher's saved vector of the unchanged picture
    seed: int = 0


class _Views(Dataset):
    """Training pictures for both models: the same random change, at the student's size and (when
    the teacher looks too) the teacher's. With a cached teacher the change is kept gentle, since
    the target is the teacher's vector of the unchanged picture."""

    def __init__(self, paths: list[str], student_px: int, teacher_px: int | None) -> None:
        self.paths, self.student_px, self.teacher_px = paths, student_px, teacher_px
        self.change = augmentation(max(student_px, teacher_px or 0), light=teacher_px is None)

    def __len__(self) -> int:
        return len(self.paths)

    def __getitem__(self, i: int):
        picture = Image.open(self.paths[i]).convert("RGB")
        picture = self.change(picture if self.teacher_px is None else turned(picture))
        student = to_tensor(picture, self.student_px)
        teacher = to_tensor(picture, self.teacher_px) if self.teacher_px else torch.empty(0)
        return student, teacher, i


def nearest(vectors: torch.Tensor, k: int, device: str) -> np.ndarray:
    """For each row, the k rows most like it (itself first), as indices."""
    everything = vectors.to(device)
    out = np.empty((len(vectors), k), dtype=np.int32)
    for start in range(0, len(vectors), 2048):
        sims = everything[start:start + 2048] @ everything.T
        out[start:start + 2048] = sims.topk(k, dim=1).indices.cpu().numpy()
    return out


def loss(student: torch.Tensor, teacher: torch.Tensor, anchors: torch.Tensor, s: Settings):
    """`student` and `teacher` are unit vectors for the same pictures [B, d]; `anchors` are each
    picture's nearest gallery vectors in the teacher's space [B, K, d]."""
    together = (student * teacher).sum(dim=1, keepdim=True)
    feature = (1 - together).mean()
    # Similarities to the teacher's own vector, then to the anchors: the student's row should
    # spread its weight across them as the teacher's row does.
    wanted = torch.cat([torch.ones_like(together), torch.einsum("bd,bkd->bk", teacher, anchors)], dim=1)
    given = torch.cat([together, torch.einsum("bd,bkd->bk", student, anchors)], dim=1)
    context = F.kl_div(F.log_softmax(given / s.student_temperature, dim=1),
                       F.softmax(wanted / s.teacher_temperature, dim=1), reduction="batchmean")
    return s.feature_weight * feature + s.context_weight * context


def _scores(results: list[dict]) -> dict:
    summary = evaluate.summary(results)
    if not summary["queries"]:
        return {}
    return {"type_top1": summary["type"]["both"]["top1"], "type_top10": summary["type"]["both"]["top10"],
            "design_top10": summary["design"]["both"]["top10"]}


def markdown(name: str, s: Settings, teacher_name: str, teacher_alone: dict, history: list[dict]) -> str:
    pct = lambda x: "n/a" if x is None else f"{100 * x:.1f}%"
    out = [f"# Distillation run `{name}`", "",
           f"Student {s.model} at {s.resolution}px, taught by `{teacher_name}`"
           + (" (its saved vectors of the unchanged pictures)." if s.cached_teacher else "."),
           "", f"The teacher alone, on the held-out collections: type top 1 {pct(teacher_alone.get('type_top1'))}, "
               f"top 10 {pct(teacher_alone.get('type_top10'))}, design top 10 {pct(teacher_alone.get('design_top10'))}.",
           "", "\"Mixed\" is how the model will be used: the student embeds the query and searches a "
               "gallery the teacher embedded. \"Alone\" has the student embed both. Pass 0 is before "
               "any teaching.",
           "", "| Pass | Loss | Mixed type top 1 | Mixed type top 10 | Mixed design top 10 | "
               "Alone type top 1 | Alone type top 10 |", "|---|---|---|---|---|---|---|"]
    for row in history:
        mixed, alone = row.get("mixed", {}), row.get("alone", {})
        loss_text = "" if row.get("loss") is None else f"{row['loss']:.3f}"
        out.append(f"| {row['epoch']} | {loss_text} | {pct(mixed.get('type_top1'))} | "
                   f"{pct(mixed.get('type_top10'))} | {pct(mixed.get('design_top10'))} | "
                   f"{pct(alone.get('type_top1'))} | {pct(alone.get('type_top10'))} |")
    return "\n".join(out) + "\n"


def distil(specimens: list[Specimen], data_dir: Path, run_dir: Path, settings: Settings,
           device: str | None = None, workers: int | None = None, log=print) -> list[dict]:
    device = device or resources.pick_device()
    resources.cap_gpu_memory(device)
    run_dir.mkdir(parents=True, exist_ok=True)
    teacher_path = Path(settings.teacher)
    told = torch.load(teacher_path, map_location="cpu", weights_only=True)["settings"]
    teacher_name = f"{teacher_path.parent.name}-{teacher_path.stem}"
    views = crops.prepare(specimens, data_dir, workers, log=log)
    pairs = [(v.specimen_id, v.side) for v in views]
    rows = evaluate.complete(specimens, pairs)
    gallery, held_out, _ = evaluate.split(specimens, rows)
    grade_device = "cuda" if torch.cuda.is_available() else "cpu"

    # The teacher's vectors of every unchanged picture: the gallery the student will search, and
    # where each training picture's neighbours come from.
    clean = torch.from_numpy(embed(views, data_dir, tag=teacher_name, model_name=told["model"],
                                   weights=teacher_path, resolution=told["resolution"], device=device,
                                   workers=workers, log=log).astype(np.float32))
    in_training = {s.id for s in specimens if not s.held_out}
    training = [i for i, v in enumerate(views) if v.specimen_id in in_training]
    paths = [str(views[i].path) for i in training]
    by_id = {s.id: s for s in specimens}
    label = [getattr(by_id[views[i].specimen_id], f"{views[i].side}_class") for i in training]
    k = min(settings.neighbours, len(training))
    table = run_dir / "neighbours.npy"
    if table.exists() and np.load(table, mmap_mode="r").shape == (len(training), k):
        neighbours = np.load(table)
    else:
        log(f"finding each training picture's {k:,} nearest gallery coins")
        neighbours = nearest(clean[training], k, device)
        np.save(table, neighbours)
        resources.release()
    log(f"{len(training):,} training pictures; teacher {teacher_name} "
        f"({told['model']} at {told['resolution']}px, {clean.shape[1]} numbers per picture)")

    torch.manual_seed(settings.seed)
    random.seed(settings.seed)
    student = load_model(settings.model, settings.resolution, device,
                         Path(settings.init) if settings.init else None)
    if isinstance(student, Projected):       # starting from an earlier distilled student
        student = student.backbone
    head = nn.Linear(student.num_features, clean.shape[1]).to(device)
    teacher = None
    if not settings.cached_teacher:
        teacher = load_model(told["model"], told["resolution"], device, teacher_path)
        teacher.requires_grad_(False)
    anchors_from = clean[training].to(device)
    anchors_from = anchors_from.half() if device == "cuda" else anchors_from
    optimiser = torch.optim.AdamW([
        {"params": student.parameters(), "lr": settings.lr, "weight_decay": settings.weight_decay},
        {"params": head.parameters(), "lr": settings.head_lr, "weight_decay": 0.0}])
    full_steps = [group["lr"] for group in optimiser.param_groups]
    scaler = torch.amp.GradScaler("cuda", enabled=device == "cuda")
    state = {"epoch": 0, "seen": 0, "batch_size": settings.batch_size, "history": [], "best": -1.0,
             "loss_sum": 0.0, "loss_count": 0, "teacher_alone": None}

    last = run_dir / "last.pt"
    if last.exists():
        saved = torch.load(last, map_location="cpu", weights_only=False)
        if saved["teacher"] != teacher_name or saved["pictures"] != len(training):
            raise SystemExit(f"{last} was made with another teacher or other data; "
                             "use a new --name or delete the folder")
        student.load_state_dict(saved["backbone"])
        head.load_state_dict(saved["head"])
        optimiser.load_state_dict(saved["optimiser"])
        scaler.load_state_dict(saved["scaler"])
        state = saved["state"]
        log(f"resuming {run_dir.name}: pass {state['epoch'] + 1}, "
            f"{state['seen']:,} of {len(training):,} pictures in, batch {state['batch_size']}")

    def save() -> None:
        _save(last, {"backbone": student.state_dict(), "head": head.state_dict(),
                     "optimiser": optimiser.state_dict(), "scaler": scaler.state_dict(), "state": state,
                     "teacher": teacher_name, "pictures": len(training), "settings": asdict(settings)})

    def grade(epoch: int, average_loss: float | None) -> None:
        if state["teacher_alone"] is None:
            state["teacher_alone"] = _scores(evaluate.run(held_out, gallery, rows, clean, grade_device))
        tag = f"{run_dir.name}-pass{epoch}"
        own = torch.from_numpy(embed(views, data_dir, tag=tag, model=Projected(student, head),
                                     resolution=settings.resolution, device=device, workers=workers,
                                     batch_size=max(state["batch_size"], 64), log=log).astype(np.float32))
        shutil.rmtree(data_dir / "embeddings" / f"{tag}-{settings.resolution}", ignore_errors=True)
        mixed = _scores(evaluate.run(held_out, gallery, rows, clean, grade_device, query_sets=[(rows, own)]))
        alone = _scores(evaluate.run(held_out, gallery, rows, own, grade_device))
        state["history"].append({"epoch": epoch, "loss": average_loss, "mixed": mixed, "alone": alone})
        score = mixed.get("type_top1", 0.0) + mixed.get("type_top10", 0.0)
        if score > state["best"]:
            state["best"] = score
            _save(run_dir / "best.pt", {"backbone": student.state_dict(), "head": head.state_dict(),
                                         "epoch": epoch, "teacher": teacher_name,
                                         "settings": asdict(settings)})
        (run_dir / "history.json").write_text(json.dumps(
            {"teacher": teacher_name, "teacher_alone": state["teacher_alone"], "passes": state["history"]},
            indent=2))
        (run_dir / "report.md").write_text(
            markdown(run_dir.name, settings, teacher_name, state["teacher_alone"], state["history"]))
        log(f"pass {epoch}: mixed type top 10 {100 * mixed.get('type_top10', 0):.1f}%, "
            f"student alone {100 * alone.get('type_top10', 0):.1f}%, "
            f"teacher alone {100 * state['teacher_alone'].get('type_top10', 0):.1f}%")

    if not state["history"]:
        grade(0, None)
        save()
    elif state["history"][-1]["epoch"] < state["epoch"]:
        log(f"pass {state['epoch']} was trained but not graded; grading it now")
        grade(state["epoch"], None)
        save()

    per_label = Counter(label)
    weights = [per_label[name] ** -0.5 for name in label]
    total = settings.epochs * len(training)
    n_workers = resources.workers(workers)
    log(f"teaching on {device}: {settings.epochs} passes, batch {state['batch_size']}, "
        f"{n_workers} helper processes, teacher "
        + ("read from its saved vectors" if teacher is None else "looking at every batch"))
    while state["epoch"] < settings.epochs:
        student.train()
        saved_at = time.monotonic()
        try:
            sampler = WeightedRandomSampler(weights, replacement=True,
                                            num_samples=max(len(training) - state["seen"], state["batch_size"]))
            loader = DataLoader(_Views(paths, settings.resolution, None if teacher is None else told["resolution"]),
                                batch_size=state["batch_size"], sampler=sampler, num_workers=n_workers,
                                drop_last=True)
            with tqdm(total=len(training), initial=state["seen"], unit="pic", smoothing=0.05,
                      dynamic_ncols=True, desc=f"pass {state['epoch'] + 1}/{settings.epochs}") as bar:
                for small, large, index in loader:
                    share = _step_size((state["epoch"] * len(training) + state["seen"]) / total, settings.warmup)
                    for group, full in zip(optimiser.param_groups, full_steps):
                        group["lr"] = full * share
                    anchors = anchors_from[torch.from_numpy(neighbours[index.numpy()]).to(device)].float()
                    with torch.autocast("cuda", enabled=device == "cuda"):
                        given = head(student(small.to(device)))
                        if teacher is None:
                            wanted = anchors_from[index.to(device)]
                        else:
                            with torch.no_grad():
                                wanted = teacher(large.to(device))
                    batch_loss = loss(F.normalize(given.float(), dim=1), F.normalize(wanted.float(), dim=1),
                                      anchors, settings)
                    optimiser.zero_grad(set_to_none=True)
                    scaler.scale(batch_loss).backward()
                    scaler.unscale_(optimiser)
                    nn.utils.clip_grad_norm_(student.parameters(), 1.0)
                    scaler.step(optimiser)
                    scaler.update()
                    state["seen"] += len(small)
                    state["loss_sum"] += batch_loss.item()
                    state["loss_count"] += 1
                    bar.update(len(small))
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
        average = state["loss_sum"] / max(1, state["loss_count"])
        state.update(seen=0, loss_sum=0.0, loss_count=0)
        save()
        grade(state["epoch"], average)
        save()
    log(f"done: best weights in {run_dir / 'best.pt'}, report in {run_dir / 'report.md'}")
    return state["history"]
