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

## Train

```sh
uv run solidi-ml train        # writes runs/finetune/: report.md, best.pt (the best weights), last.pt
uv run solidi-ml baseline --weights runs/finetune/best.pt     # the full report for the trained model
```

`train` fine-tunes the model on the gallery collections and, after every pass over the pictures,
grades it on the held-out collections exactly as the baseline is graded. Pass 0 in its report is
the untrained model, so every later row can be read against it.

It is safe to interrupt. Progress is saved every ten minutes and after each pass; run the same
command again and it resumes. Choose `--epochs` before starting: raising it on a resumed run
works, but the step size, which eases down to zero by the last pass, jumps back up.

## Memory

Every command sizes itself to the machine. The number of helper processes is chosen from the
processor cores and the memory free when it starts (`--workers N` overrides it), and if the
graphics card or the system runs out of memory the batch is halved and the work carries on.
Photos are cut down to the coin once, into `data/crops/` (about 10 GB for the full set), and
vectors are saved in blocks, so `baseline` and `diagnose` also resume after a stop.

For a five-minute trial first, add `--sample-types 60 --collections ans princeton fralin` to each
command. With so few types to choose from its scores are far too high to mean anything; it only
shows that everything runs.

## What it measures

The baseline uses DINOv2 (small, with registers) exactly as published. Nothing is trained;
`train` starts from the same model.

1. Every photo is cut down to the coin (the largest roundish object that stands out from the
   background) and turned into a vector, obverse and reverse separately.
2. Coins from the American Numismatic Society and SITNAM form the gallery.
3. Each test coin's two sides are compared with every gallery coin's. Types are ranked by their
   best-matching coin, and we record where the true type lands.

Many types look alike and differ only in a legend break or a small symbol, so every score is
given twice: for the exact **type**, and for the **design**, which groups types with the same
denomination, portrait and reverse description.

Held-out coins whose catalogue links can't be trusted (listed in `records.DOUBTFUL`) are graded in
a section of their own and kept out of the held-out score.

Two tests are reported. **Held-out collections** uses coins from museums that are not in the
gallery, so the photographer, background and lighting are all new; this is the number that
matters. **Same collection** searches each ANS coin against the others, which is easier but has
far more coins.

## Data and licences

`download` reads the release named in `src/solidi_ml/release.py`, which holds only openly
licensed data (ODbL, CC BY, CC0, public domain). The Bibliothèque nationale de France is left out
because it disputes reuse of its photographs. Photos are kept in `data/` and are not
redistributed.
