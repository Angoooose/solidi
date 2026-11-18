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

## Data licences

Type data from OCRE is ODbL, so the built database must be published under ODbL. Each specimen's dataset carries its own licence; see the `dataset` table.
