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


def _baseline(args) -> None:
    from .embed import embed
    from .evaluate import evaluate, markdown
    name, specimens = _specimens(args)
    views, vectors = embed(specimens, Path(args.data), model_name=args.model,
                           resolution=args.resolution, batch_size=args.batch_size,
                           device=args.device, workers=args.workers)
    report = {"release": name, "model": args.model, "resolution": args.resolution,
              **evaluate(specimens, views, vectors)}
    out = Path(args.runs) / f"{time.strftime('%Y%m%d-%H%M%S')}-baseline"
    out.mkdir(parents=True)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    (out / "report.md").write_text(text := markdown(report))
    print("\n" + text)
    print(f"report saved in {out}")


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
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("download", parents=[common], help="download the photos (resumable)"
                        ).set_defaults(run=_download)
    baseline = commands.add_parser("baseline", parents=[common],
                                   help="embed the photos with a pretrained model and grade it")
    baseline.add_argument("--model", default=MODEL, help="a timm model name")
    baseline.add_argument("--resolution", type=int, default=RESOLUTION)
    baseline.add_argument("--batch-size", type=int, default=256)
    baseline.add_argument("--workers", type=int, default=4, help="processes preparing photos")
    baseline.add_argument("--device", help="cuda, mps or cpu (default: the best available)")
    baseline.add_argument("--runs", default="runs", help="where reports are written")
    baseline.set_defaults(run=_baseline)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
