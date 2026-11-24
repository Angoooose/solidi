"""`solidi-ml`: download the photos, then measure a model on them."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from . import records, release


def _specimens(args) -> tuple[str, list[records.Specimen]]:
    """The release named on the command line (or a local database file) and its specimens."""
    data_dir = Path(args.data)
    if args.db:
        name, db = Path(args.db).name, Path(args.db)
    else:
        name, db = args.release, release.fetch(args.release, data_dir)
    specimens = records.load(db, size=args.size)
    if args.collections:
        specimens = [s for s in specimens if s.collection in args.collections]
    if args.sample_types:
        specimens = records.sample_types(specimens, args.sample_types)
    return name, specimens


def _download(args) -> None:
    from .download import download
    _, specimens = _specimens(args)
    download(specimens, Path(args.data), size=args.size)


def _embed_args(args) -> dict:
    return {"model_name": args.model, "resolution": args.resolution, "batch_size": args.batch_size,
            "device": args.device, "workers": args.workers}


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
    from .embed import embed
    from .evaluate import coin_found, evaluate, markdown
    name, specimens = _specimens(args)
    views, vectors, found = embed(specimens, Path(args.data), **_embed_args(args))
    report = {"release": name, "model": args.model, "resolution": args.resolution,
              "coin_found": coin_found(specimens, views, found),
              **evaluate(specimens, views, vectors)}
    _save(_run_dir(args, "baseline"), report, markdown(report))


def _diagnose(args) -> None:
    from .diagnose import diagnose, markdown
    name, specimens = _specimens(args)
    out = _run_dir(args, "diagnose")
    report = {"release": name, "model": args.model, "resolution": args.resolution,
              **diagnose(specimens, Path(args.data), out, **_embed_args(args))}
    _save(out, report, markdown(report))


def main() -> None:
    from .embed import MODEL, RESOLUTION
    parser = argparse.ArgumentParser(prog="solidi-ml", description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--release", default=release.RELEASE, help="release tag to read (default %(default)s)")
    common.add_argument("--db", help="read this local .sqlite file instead of a release")
    common.add_argument("--data", default="data", help="where photos and vectors are kept")
    common.add_argument("--size", type=int, default=512, help="longest side of a saved photo, px")
    common.add_argument("--collections", nargs="+", metavar="NAME",
                        help=f"only these collections ({', '.join(records.COLLECTIONS.values())})")
    common.add_argument("--sample-types", type=int, metavar="N",
                        help="a small trial: only N types that have held-out coins")
    model = argparse.ArgumentParser(add_help=False)
    model.add_argument("--model", default=MODEL, help="a timm model name")
    model.add_argument("--resolution", type=int, default=RESOLUTION)
    model.add_argument("--batch-size", type=int, default=256)
    model.add_argument("--workers", type=int, default=4, help="processes preparing photos")
    model.add_argument("--device", help="cuda, mps or cpu (default: the best available)")
    model.add_argument("--runs", default="runs", help="where reports are written")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("download", parents=[common], help="download the photos (resumable)"
                        ).set_defaults(run=_download)
    commands.add_parser("baseline", parents=[common, model],
                        help="embed the photos with a pretrained model and grade it"
                        ).set_defaults(run=_baseline)
    commands.add_parser("diagnose", parents=[common, model],
                        help="check why held-out coins are missed: colour, rotation, a sheet of misses"
                        ).set_defaults(run=_diagnose)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
