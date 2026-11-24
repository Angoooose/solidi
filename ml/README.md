# Solidi ML

Work towards identifying a coin's type from a photograph. This folder is its own Python project,
separate from the pipeline: it reads a published Solidi data release and nothing else from the repo.

## Run the baseline

Requires [uv](https://docs.astral.sh/uv/). An NVIDIA GPU is used if there is one (Windows or
Linux); a Mac uses Metal.

```sh
cd ml
uv sync
uv run solidi-ml download     # about 220,000 photos; several hours, safe to stop and rerun
uv run solidi-ml baseline     # embeds the photos, grades the model, writes runs/<time>-baseline/
```

To see why held-out coins are missed, run the diagnostics afterwards (they reuse the photos and
the baseline's vectors, and embed everything once more in greyscale):

```sh
uv run solidi-ml diagnose     # writes runs/<time>-diagnose/report.md and misses.png
```

It compares the held-out scores as photographed, in greyscale, and with each query turned in
45-degree steps, and saves a sheet of missed coins beside their nearest matches.

For a five-minute trial first, add `--sample-types 60 --collections ans princeton fralin` to each
command. With so few types to choose from its scores are far too high to mean anything; it only
shows that everything runs.

## What it measures

The baseline uses DINOv2 (small, with registers) exactly as published. Nothing is trained.

1. Every photo is cut down to the coin (the largest roundish object that stands out from the
   background) and turned into a vector, obverse and reverse separately.
2. Coins from the American Numismatic Society and SITNAM form the gallery.
3. Each test coin's two sides are compared with every gallery coin's. Types are ranked by their
   best-matching coin, and we record where the true type lands.

Many types look alike and differ only in a legend break or a small symbol, so every score is
given twice: for the exact **type**, and for the **design**, which groups types with the same
denomination, portrait and reverse description.

Two tests are reported. **Held-out collections** uses coins from museums that are not in the
gallery, so the photographer, background and lighting are all new; this is the number that
matters. **Same collection** searches each ANS coin against the others, which is easier but has
far more coins.

## Data and licences

`download` reads the release named in `src/solidi_ml/release.py`, which holds only openly
licensed data (ODbL, CC BY, CC0, public domain). The Bibliothèque nationale de France is left out
because it disputes reuse of its photographs. Photos are kept in `data/` and are not
redistributed.
