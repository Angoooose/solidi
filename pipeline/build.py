"""`solidi build`: fetch → stage → link → check → build, from scratch."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

import yaml

from pipeline import categories, image_score, images, legends, regions, search, stage, summaries, transform
from pipeline.legend_expand import Dictionary
from pipeline.checks import checks
from pipeline.link import wikidata, wikipedia
from pipeline.sources.cn import monograms as cn_monograms
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
    files += cn_monograms.fetch(raw, files, refresh=refresh)

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
    print("enrich: wikipedia")
    wikipedia.enrich(db, raw, refresh=refresh)

    abbreviations = ROOT / "data" / "legend_abbreviations.yaml"
    dictionary = Dictionary.load(abbreviations) if abbreviations.exists() else None
    languages = {k: c.get("legend_language", "la") for k, c in config["corpora"].items()}
    print(f"index legends: {legends.build_index(db, dictionary, languages)}")

    print("categories")
    categories.load_and_assign(db, ROOT / "data" / "categories.yaml")
    print("regions")
    region_warnings = regions.load_and_apply(db, ROOT / "data" / "regions.yaml")
    print("images")
    images.flag_unusable(db, config)
    print("image scores")
    image_score.load(db, raw)
    print("summaries")
    summaries.build(db)
    print("search")
    search.build(db)

    print("check")
    result = checks.run(db)
    result.warnings.extend(region_warnings)
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
    e = sub.add_parser("export-d1", help="write the built database as SQL for Cloudflare D1")
    e.add_argument("--build-dir", type=Path, default=ROOT / "build")
    s = sub.add_parser("score-images", help="download and score candidate photos into the cache (slow the first time)")
    s.add_argument("--build-dir", type=Path, default=ROOT / "build")
    s.add_argument("--rescore", action="store_true", help="recompute scores from the kept thumbnails, no downloads")
    r = sub.add_parser("release", help="write the downloadable ODbL copy of the database (build/release/)")
    r.add_argument("--build-dir", type=Path, default=ROOT / "build")
    r.add_argument("--publish", action="store_true", help="also publish it as a GitHub release (the repo must be public)")
    args = parser.parse_args()
    if args.command == "score-images":
        raw = args.build_dir / "raw"
        if args.rescore:
            print(f"rescored {image_score.rescore(raw):,}")
        else:
            image_score.score_images(sqlite3.connect(args.build_dir / "solidi.sqlite"), raw)
        return
    if args.command == "build":
        sys.exit(build(args.authority, args.refresh, args.build_dir))
    if args.command == "release":
        from pipeline import release
        config = yaml.safe_load((ROOT / "data" / "sources.yaml").read_text())
        out_dir, info = release.build_release(args.build_dir, config["release_licences"])
        a, b = info["after"], info["before"]
        size = (out_dir / release.ASSET).stat().st_size / 1e6
        print(f"{out_dir / release.ASSET} ({size:.1f} MB): {a['coin_type']:,} of {b['coin_type']:,} types, "
              f"{a['specimen']:,} of {b['specimen']:,} specimens; {len(info['left_out'])} sources left out (NOTES.md)")
        if args.publish:
            print(f"published {release.publish(out_dir, info['built_at'])}")
        return
    if args.command == "export-d1":
        from pipeline import export_d1
        src, out = args.build_dir / "solidi.sqlite", args.build_dir / "solidi.sql"
        counts = export_d1.export(src, out, max_bytes=100_000_000)
        parts = export_d1.export.paths
        size = sum(p.stat().st_size for p in parts) / 1e6
        print(f"{sum(counts.values()):,} rows in {len(counts)} tables -> {len(parts)} files "
              f"{parts[0].name}..{parts[-1].name} ({size:.1f} MB)")


if __name__ == "__main__":
    main()
