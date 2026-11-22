# Solidi

An encyclopedia of ancient coinage, built on open scholarly data (OCRE, Nomisma.org and partner collections).

## Build the dataset

```sh
uv sync
uv run solidi build --authority trajan   # one emperor, for fast iteration
uv run solidi build                      # all of OCRE
```

Raw downloads are cached in `build/raw/`; the output is `build/solidi.sqlite`, plus `build/report.json` with coverage figures. Browse the output with `uvx datasette build/solidi.sqlite`.

## Layout

- `pipeline/` - fetch → stage → link → check → build
- `data/` - hand-maintained inputs (`sources.yaml`)
- `site/` - the website (later); reads only the built SQLite
- `ml/` - photo identification experiment (later)

## Licences

- **Code** (`pipeline/`, `site/`, `tests/`): MIT, see `LICENSE`.
- **Hand-written data** (`data/`): CC BY 4.0, except `data/legends/abbreviations.yaml`, which is ODbL because it was seeded from OCRE-derived data. See `data/LICENSE`.
- **The built database** and its download: ODbL, because OCRE's type data is ODbL. Each specimen's dataset carries its own licence; see the `dataset` table.
- **Photographs** stay under the terms of the collection that holds each coin, and **Wikipedia introductions** under CC BY-SA 4.0. Neither is covered by the licences above.

## Release

`uv run solidi release` writes the downloadable copy to `build/release/`: only data whose licence can be shared under the ODbL (`release_licences` in `data/sources.yaml`), without the site-only tables, gzipped, with a checksum and release notes. `--publish` creates the GitHub release; the repository must be public.
