# Solidi ML

Work towards identifying a coin's type from a photograph. This folder is its own Python project,
separate from the pipeline: it reads one data file the pipeline makes, and nothing else from the
repo.

## Get the data

The pipeline writes the data file. In the repo root, on a machine where the pipeline has been
built:

```sh
uv run solidi training-data      # writes build/training/dataset.sqlite.gz (about 22 MB)
```

Copy that file into `ml/data/` on the machine that will train. That is the only thing to move;
every command below reads it from there and unpacks it by itself.

The file lists photographed coins from every collection whose licence lets a non-commercial
project train on its photos. Which collections those are is decided in one place, `training` in
`data/sources.yaml`. It includes collections under non-commercial licences, so **don't publish
the file, and share weights trained on it only under CC BY-NC-SA 4.0, crediting the collections**.
Such weights can never be used commercially.

## Run

Requires [uv](https://docs.astral.sh/uv/). An NVIDIA GPU is used if there is one (Windows or
Linux); a Mac uses Metal.

```sh
cd ml
uv sync
uv run solidi-ml collections   # what is in the dataset, and how each collection is used
uv run solidi-ml download      # fetch the photos; safe to stop and rerun
uv run solidi-ml train         # writes runs/finetune/: report.md, best.pt, last.pt
```

`train` fine-tunes the model on the gallery collections and, after every pass over the pictures,
grades it on the held-out collections. Pass 0 in its report is the untrained model, so every
later row can be read against it.

It is safe to interrupt. Progress is saved every ten minutes and after each pass; run the same
command again and it resumes. Choose `--epochs` before starting: raising it on a resumed run
works, but the step size, which eases down to zero by the last pass, jumps back up.

### Teaching the small model from a large one

A browser can only run the small model, but the gallery is embedded offline, where a large model
costs nothing. `train --teacher` trains the small model to place a photo where the large one
would, so a query embedded by the small model can search a gallery embedded by the large one:

```sh
uv run solidi-ml train --name b336-34c --model vit_base_patch14_reg4_dinov2.lvd142m --resolution 336
uv run solidi-ml train --name s224-from-b336 --teacher runs/b336-34c/best.pt --init runs/s224-34c/best.pt
```

Its report grades each pass three ways: "mixed" (small model on the query, large model on the
gallery, which is how it will be used), the small model alone, and the large model alone. The
large model looks at every batch, so a pass takes several times longer than plain training;
`--cached-teacher` uses its saved vectors instead, which is much faster and a weaker method.
The approach and the papers it follows are described in `src/solidi_ml/distil.py`.

Two more commands look closer at a model, the untrained one by default or a trained one with
`--weights runs/finetune/best.pt`:

```sh
uv run solidi-ml baseline      # the full report: by museum, by catalogue, by photos per type
uv run solidi-ml diagnose      # colour, rotation, and a sheet of missed coins (misses.png)
```

For a five-minute trial of any command, add `--sample-types 25`. With so few types to choose
from its scores are far too high to mean anything; it only shows that everything runs.

## What is measured

1. Every photo is cut down to the coin (the largest roundish object that stands out from the
   background) and turned into a vector, obverse and reverse separately.
2. Most collections form the gallery, which is also what the model trains on. A few are held out
   whole (`HELD_OUT` in `src/solidi_ml/records.py`): never trained on, never searched.
3. Each test coin's two sides are compared with every gallery coin's. Types are ranked by their
   best-matching coin, and we record where the true type lands.

Many types look alike and differ only in a legend break or a small symbol, so every score is
given twice: for the exact **type**, and for the **design**, which groups types with the same
denomination, portrait and reverse description.

Held-out coins whose catalogue links can't be trusted (`DOUBTFUL` in `records.py`) are graded in
a section of their own and kept out of the held-out score.

Two tests are reported. **Held-out collections** uses coins from museums that are not in the
gallery, so the photographer, background and lighting are all new; this is the number that
matters. **Same collection** searches each ANS coin against the others, which is easier but has
far more coins.

## Memory and disk

Every command sizes itself to the machine. The number of helper processes is chosen from the
processor cores and the memory free when it starts (`--workers N` overrides it), and if the
graphics card or the system runs out of memory the batch is halved and the work carries on.
Photos are cut down to the coin once, into `data/crops/`, and vectors are saved in blocks, so
`baseline` and `diagnose` also resume after a stop. Photos stay in `data/` and are not
redistributed.
