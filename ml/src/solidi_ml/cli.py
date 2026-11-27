"""`solidi-ml`: download the photos, then measure a model on them."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from . import dataset, records


def _specimens(args) -> tuple[str, list[records.Specimen]]:
    """What the dataset is (for reports) and its specimens, narrowed as the command line asks."""
    db = dataset.locate(Path(args.data))
    specimens = records.load(db, size=args.size)
    if args.collections:
        specimens = [s for s in specimens if s.collection in args.collections]
    if args.sample_types:
        specimens = records.sample_types(specimens, args.sample_types)
    return dataset.describe(db), specimens


def _collections(args) -> None:
    rows = records.census(dataset.locate(Path(args.data)))
    for role in ("gallery", "held out"):
        chosen = [r for r in rows if r["role"] == role]
        print(f"\n{role}: {len(chosen)} collections, {sum(r['coins'] for r in chosen):,} coins")
        for r in chosen:
            print(f"  {r['coins']:>7,}  {r['collection']:<32.32}  {r['licence']}")


def _download(args) -> None:
    from .download import download
    _, specimens = _specimens(args)
    download(specimens, Path(args.data), size=args.size)


def _embed_args(args) -> dict:
    return {"model_name": args.model, "resolution": args.resolution, "batch_size": args.batch_size,
            "device": args.device, "workers": args.workers,
            "weights": Path(args.weights) if args.weights else None,
            "tag": f"{Path(args.weights).parent.name}-{Path(args.weights).stem}" if args.weights else None}


def _run_dir(args, kind: str) -> Path:
    out = Path(args.runs) / f"{time.strftime('%Y%m%d-%H%M%S')}-{kind}"
    out.mkdir(parents=True)
    return out


def _save(out: Path, report: dict, text: str) -> None:
    (out / "report.json").write_text(json.dumps(report, indent=2))
    (out / "report.md").write_text(text)
    print("\n" + text)
    print(f"saved in {out}")


def _baseline(args) -> None:
    from . import crops
    from .embed import embed
    from .evaluate import coin_found, evaluate, markdown
    name, specimens = _specimens(args)
    views = crops.prepare(specimens, Path(args.data), args.workers)
    vectors = embed(views, Path(args.data), **_embed_args(args))
    pairs = [(v.specimen_id, v.side) for v in views]
    report = {"dataset": name, "model": args.weights or args.model, "resolution": args.resolution,
              "coin_found": coin_found(specimens, pairs, [v.found for v in views]),
              **evaluate(specimens, pairs, vectors,
                         gallery_from=tuple(args.gallery) if args.gallery else None)}
    _save(_run_dir(args, "baseline"), report, markdown(report))


def _diagnose(args) -> None:
    from .diagnose import diagnose, markdown
    name, specimens = _specimens(args)
    out = _run_dir(args, "diagnose")
    report = {"dataset": name, "model": args.weights or args.model, "resolution": args.resolution,
              **diagnose(specimens, Path(args.data), out, **_embed_args(args))}
    _save(out, report, markdown(report))


def _index(args) -> None:
    import torch
    from . import crops, index
    from .embed import embed
    name, specimens = _specimens(args)
    views = crops.prepare(specimens, Path(args.data), args.workers)

    def vectors(weights: str):
        path = Path(weights)
        told = torch.load(path, map_location="cpu", weights_only=True)["settings"]
        return embed(views, Path(args.data), tag=f"{path.parent.name}-{path.stem}",
                     model_name=told["model"], weights=path, resolution=told["resolution"],
                     batch_size=args.batch_size, device=args.device, workers=args.workers)

    query = vectors(args.weights)
    gallery = vectors(args.teacher) if args.teacher else query
    report = {"dataset": name, "query_model": args.weights, "gallery_model": args.teacher or args.weights,
              **index.measure(specimens, [(v.specimen_id, v.side) for v in views], gallery, query)}
    _save(_run_dir(args, "index"), report, index.markdown(report))


def _train(args) -> None:
    _, specimens = _specimens(args)
    if args.teacher:
        from .distil import Settings as Teaching, distil
        teaching = Teaching(teacher=args.teacher, init=args.init or "", model=args.model,
                            resolution=args.resolution, epochs=args.epochs, batch_size=args.batch_size,
                            lr=args.lr, cached_teacher=args.cached_teacher)
        distil(specimens, Path(args.data), Path(args.runs) / args.name, teaching,
               device=args.device, workers=args.workers)
        print("\n" + (Path(args.runs) / args.name / "report.md").read_text())
        return
    from .train import Settings, train
    settings = Settings(model=args.model, resolution=args.resolution, epochs=args.epochs,
                        batch_size=args.batch_size, lr=args.lr, head_lr=args.head_lr)
    train(specimens, Path(args.data), Path(args.runs) / args.name, settings,
          device=args.device, workers=args.workers)
    print("\n" + (Path(args.runs) / args.name / "report.md").read_text())


def main() -> None:
    from .embed import MODEL, RESOLUTION
    parser = argparse.ArgumentParser(prog="solidi-ml", description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data", default="data",
                        help="where the dataset, photos and vectors are kept (default %(default)s)")
    common.add_argument("--size", type=int, default=512, help="longest side of a saved photo, px")
    common.add_argument("--collections", nargs="+", metavar="NAME",
                        help=f"only these collections ({', '.join(records.COLLECTIONS.values())})")
    common.add_argument("--sample-types", type=int, metavar="N",
                        help="a small trial: only N types that have held-out coins")
    machine = argparse.ArgumentParser(add_help=False)
    machine.add_argument("--model", default=MODEL, help="a timm model name")
    machine.add_argument("--resolution", type=int, default=RESOLUTION)
    machine.add_argument("--workers", type=int,
                         help="helper processes preparing pictures (default: chosen from the "
                              "processor cores and free memory)")
    machine.add_argument("--device", help="cuda, mps or cpu (default: the best available)")
    machine.add_argument("--runs", default="runs", help="where reports are written")
    grading = argparse.ArgumentParser(add_help=False)
    grading.add_argument("--batch-size", type=int, default=256,
                         help="pictures per batch (halved automatically if memory runs out)")
    grading.add_argument("--weights", help="grade a trained model: a best.pt written by `train`")
    grading.add_argument("--gallery", nargs="+", metavar="NAME",
                         help="search only these gallery collections (default: all of them); "
                              "`baseline` only")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("collections", parents=[common],
                        help="list the collections in the dataset and how each is used"
                        ).set_defaults(run=_collections)
    commands.add_parser("download", parents=[common], help="download the photos (resumable)"
                        ).set_defaults(run=_download)
    commands.add_parser("baseline", parents=[common, machine, grading],
                        help="embed the photos with a model and grade it"
                        ).set_defaults(run=_baseline)
    commands.add_parser("diagnose", parents=[common, machine, grading],
                        help="check why held-out coins are missed: colour, rotation, a sheet of misses"
                        ).set_defaults(run=_diagnose)
    sizing = commands.add_parser("index", parents=[common],
                                 help="measure what shrinking the search index costs in accuracy")
    sizing.add_argument("--weights", required=True,
                        help="the model that embeds the query: a best.pt written by `train`")
    sizing.add_argument("--teacher", metavar="WEIGHTS",
                        help="the model that embeds the gallery, when --weights is a student "
                             "taught by it (default: the same model embeds both)")
    sizing.add_argument("--batch-size", type=int, default=256)
    sizing.add_argument("--workers", type=int)
    sizing.add_argument("--device")
    sizing.add_argument("--runs", default="runs")
    sizing.set_defaults(run=_index)
    training = commands.add_parser("train", parents=[common, machine],
                                   help="fine-tune the model; run again with the same --name to resume")
    training.add_argument("--name", default="finetune", help="the run's folder under --runs")
    training.add_argument("--epochs", type=int, default=8, help="passes over the training pictures")
    training.add_argument("--batch-size", type=int, default=128,
                          help="pictures per batch (halved automatically if memory runs out)")
    training.add_argument("--lr", type=float, default=2e-5, help="step size for the pretrained network")
    training.add_argument("--head-lr", type=float, default=5e-3, help="step size for the new label centres")
    training.add_argument("--teacher", metavar="WEIGHTS",
                          help="teach this model to answer like a larger one: the larger model's "
                               "best.pt. Labels are not used; see distil.py")
    training.add_argument("--init", metavar="WEIGHTS",
                          help="with --teacher: start the student from these weights")
    training.add_argument("--cached-teacher", action="store_true",
                          help="with --teacher: use the teacher's saved vectors of the unchanged "
                               "pictures (much faster, gentler changes to the pictures)")
    training.set_defaults(run=_train)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
