"""`solidi build`: fetch → stage → link → check → build, from scratch."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

import yaml

from pipeline import stage, transform
from pipeline.checks import checks
from pipeline.link import wikidata
from pipeline.sources.nomisma import fetch as nomisma_fetch
from pipeline.sources.numishare import fetch as numishare_fetch

ROOT = Path(__file__).resolve().parent.parent


def build(authority: str | None, refresh: bool, build_dir: Path) -> int:
    config = yaml.safe_load((ROOT / "data" / "sources.yaml").read_text())
    raw = build_dir / "raw"
    t0 = time.time()

    print("fetch")
    files = nomisma_fetch.fetch(raw, config["nomisma"], refresh=refresh)
    for key, corpus in config["corpora"].items():
        files += numishare_fetch.fetch(raw, key, corpus, authority=authority, refresh=refresh)

    print(f"stage ({len(files)} files)")
    store = stage.load(files, build_dir / "staged" / "store")

    print("link + build")
    db_path = build_dir / "solidi.sqlite"
    info = {"scope": f"authority={authority}" if authority else "all",
            "corpora": ",".join(config["corpora"])}
    transform.build(stage.Graph(store), db_path, config, info)
    db = sqlite3.connect(db_path)

    print("enrich: wikidata")
    wikidata.enrich(db, raw, refresh=refresh)

    print("check")
    result = checks.run(db)
    report = {"errors": result.errors, "warnings": result.warnings, "coverage": result.coverage,
              "seconds": round(time.time() - t0, 1)}
    (build_dir / "report.json").write_text(json.dumps(report, indent=2))
    for w in result.warnings:
        print(f"  warning: {w}")
    for e in result.errors:
        print(f"  ERROR: {e}")
    print(json.dumps(result.coverage, indent=2))
    print(f"done in {report['seconds']}s -> {db_path}")
    return 1 if result.errors else 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="solidi")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="build the dataset from scratch")
    b.add_argument("--authority", help="only types issued by this Nomisma person ID, e.g. trajan")
    b.add_argument("--refresh", action="store_true", help="re-download sources instead of using the cache")
    b.add_argument("--build-dir", type=Path, default=ROOT / "build")
    args = parser.parse_args()
    if args.command == "build":
        sys.exit(build(args.authority, args.refresh, args.build_dir))


if __name__ == "__main__":
    main()
