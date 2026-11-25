import numpy as np
from PIL import Image, ImageDraw

from solidi_ml import evaluate, records
from solidi_ml.crop import crop_coin, split_combined


def _coin_picture(size=(400, 300), box=(150, 100, 250, 200), background="white"):
    picture = Image.new("RGB", size, background)
    ImageDraw.Draw(picture).ellipse(box, fill=(120, 90, 40))
    return picture


def test_crop_finds_the_coin_and_squares_it():
    cropped, found = crop_coin(_coin_picture())
    assert found and cropped.width == cropped.height
    assert 100 <= cropped.width <= 115          # the 100px coin plus a small margin
    assert cropped.getpixel((cropped.width // 2, cropped.height // 2)) == (120, 90, 40)
    assert cropped.getpixel((0, 0)) == (255, 255, 255)


def test_crop_works_on_a_dark_background():
    cropped, _ = crop_coin(_coin_picture(background="black"))
    assert 100 <= cropped.width <= 115


def test_crop_keeps_a_picture_with_no_clear_coin():
    noise = Image.fromarray(np.random.default_rng(0).integers(0, 255, (200, 300, 3), dtype=np.uint8))
    whole, found = crop_coin(noise)
    assert not found and whole.size == (324, 324)  # whole picture, padded square with the margin


def test_crop_ignores_grid_lines_and_a_ruler():
    # A cutting mat: dark, with thin pale grid lines edge to edge and a pale ruler along the bottom.
    picture = Image.new("RGB", (500, 400), (40, 44, 50))
    draw = ImageDraw.Draw(picture)
    for x in range(0, 500, 50):
        draw.line((x, 0, x, 400), fill=(220, 220, 220), width=2)
    for y in range(0, 400, 50):
        draw.line((0, y, 500, y), fill=(220, 220, 220), width=2)
    draw.rectangle((20, 370, 480, 392), fill=(230, 230, 200))
    draw.ellipse((180, 120, 300, 240), fill=(170, 170, 175))
    cropped, found = crop_coin(picture)
    assert found and 118 <= cropped.width <= 140     # the 120px coin, not the 500px frame


def test_split_combined():
    left, right = split_combined(Image.new("RGB", (800, 400)))
    assert left.size == right.size == (400, 400)
    top, bottom = split_combined(Image.new("RGB", (400, 800)))
    assert top.size == bottom.size == (400, 400)
    assert split_combined(Image.new("RGB", (500, 400))) is None


def test_sized_url():
    assert records.sized_url("https://x/a.jpg", "https://iiif.x/id/", 512) == \
        "https://iiif.x/id/full/!512,512/0/default.jpg"
    assert records.sized_url("https://x/a.jpg", None, 512) == "https://x/a.jpg"


def _specimen(sid, collection, type_id, design=None, **labels):
    return records.Specimen(id=sid, collection=collection, type_id=type_id, corpus="ocre",
                            design=design or type_id, **labels)


def test_design_key_groups_types_a_photo_cannot_tell_apart():
    key = records.design_key
    zeus = "Zeus seated on stool-throne left, eagle on outstretched right hand"
    a = key("pella/price.227", None, "tetradrachm", "Head of Heracles right. Border of dots.", zeus)
    b = key("pella/price.1379", None, "tetradrachm", "Head of Heracles right", zeus + ".")
    assert a == b                                                  # punctuation and borders ignored
    assert key("x", None, "drachm", "Head of Heracles right", zeus) != a      # another denomination
    assert key("ocre/a", "trajan", "denarius", "Head, laureate, right", "Victory") == \
        key("ocre/b", "trajan", "denarius", "Bust, draped, right", "Victory")   # same portrait
    assert key("sco/sc.1.344", None, "bronze", "Laureate head of Zeus right", None) == "sco/sc.1.344"


def test_evaluate_ranks_types_and_never_matches_a_coin_to_itself():
    # Three types along three axes. Gallery coins sit on their type's axis; the held-out coin of
    # type A leans towards A, and the held-out coin of type C leans towards B (a miss).
    axis = {"A": [1, 0, 0], "B": [0, 1, 0], "C": [0, 0, 1]}
    specimens = [
        _specimen("a1", "ans", "A", portrait="trajan"), _specimen("a2", "ans", "A", portrait="trajan"),
        _specimen("b1", "ans", "B", design="BC", portrait="hadrian"),
        _specimen("c1", "sitnam", "C", design="BC", portrait="nero"),
        _specimen("qa", "princeton", "A", portrait="trajan"),
        _specimen("qc", "princeton", "C", design="BC", portrait="nero"),
        _specimen("qz", "princeton", "Z"),                      # its type isn't in the gallery
        _specimen("half", "ans", "B"),                          # one side only: left out
    ]
    vec = {"a1": axis["A"], "a2": axis["A"], "b1": axis["B"], "c1": axis["C"],
           "qa": [0.9, 0.1, 0], "qc": [0, 0.8, 0.6], "qz": [1, 1, 1]}
    views, vectors = [], []
    for sid, v in vec.items():
        for side in ("obverse", "reverse"):
            views.append((sid, side))
            vectors.append(np.array(v, dtype=np.float32) / np.linalg.norm(v))
    views.append(("half", "obverse"))
    vectors.append(np.array(axis["B"], dtype=np.float32))
    report = evaluate.evaluate(specimens, views, np.stack(vectors), log=lambda *_: None)

    assert report["gallery"] == {"specimens": 4, "types": 3, "designs": 2,
                                 "collections": {"ans": 3, "sitnam": 1}}
    held = report["held_out"]
    assert held["queries"] == 2
    assert held["type"]["both"] == {"top1": 0.5, "top5": 1.0, "top10": 1.0, "top50": 1.0,
                                    "top100": 1.0}                             # qa first, qc second
    assert held["design"]["both"]["top1"] == 1.0    # qc's nearest coin is type B: the same design
    assert held["labels"]["portrait"] == {"queries": 2, "top1": 0.5}
    # Same collection: only a1 and a2 have another coin of their type. Each must find the other,
    # not itself, so both rank first.
    same = report["same_collection"]
    assert same["queries"] == 2
    assert same["type"]["both"]["top1"] == 1.0
    assert same["by_bucket"] == {"1": {"queries": 2, "top1": 1.0, "top5": 1.0, "top10": 1.0,
                                       "top50": 1.0, "top100": 1.0, "design_top10": 1.0}}
    assert set(held["by_pair"]) == {"ocre / princeton"}
    # Searching the ANS coins alone drops type C from the gallery, so its held-out coin is no
    # longer a query, and the SITNAM coin does not become one.
    narrow = evaluate.evaluate(specimens, views, np.stack(vectors), log=lambda *_: None, gallery_from=("ans",))
    assert narrow["gallery"]["collections"] == {"ans": 3} and narrow["held_out"]["queries"] == 1
    found = evaluate.coin_found(specimens, views, [True] * (len(views) - 1) + [False])
    assert found["princeton"] == {"pictures": 6, "found": 1.0} and found["ans"]["found"] == 6 / 7
    text = evaluate.markdown({"release": "r", "model": "m", "resolution": 224, "coin_found": found, **report})
    assert "Held-out collections" in text and "Design top 10" in text


def test_alternative_query_vectors_keep_the_best_match():
    # The query's own vector points at type B; a second version of it (say, turned) points at
    # its true type A. With both offered, A wins and the second set is reported as the winner.
    import torch
    specimens = [_specimen("a1", "ans", "A"), _specimen("b1", "ans", "B"), _specimen("q", "princeton", "A")]
    views = [(sid, side) for sid in ("a1", "b1", "q") for side in ("obverse", "reverse")]
    rows = evaluate.complete(specimens, views)
    gallery, held_out, _ = evaluate.split(specimens, rows)
    base = torch.tensor([[1, 0], [1, 0], [0, 1], [0, 1], [0.6, 0.8], [0.6, 0.8]], dtype=torch.float32)
    turned = torch.tensor([[1, 0], [1, 0]], dtype=torch.float32)
    turned_rows = {"q": (0, 1)}
    alone = evaluate.run(held_out, gallery, rows, base, "cpu")[0]
    assert alone["rank"]["type"]["both"] == 2 and alone["nearest"][0] == "b1"
    best = evaluate.run(held_out, gallery, rows, base, "cpu",
                        query_sets=[(rows, base), (turned_rows, turned)])[0]
    assert best["rank"]["type"]["both"] == 1 and best["set"] == 1


def test_variants_and_combined_pictures():
    from solidi_ml.crop import views_of
    from solidi_ml.embed import variant
    picture, _ = crop_coin(_coin_picture())
    gray, turned = variant(picture, gray=True), variant(picture, angle=45)
    assert picture.size == gray.size == turned.size
    r, g, b = gray.getpixel((gray.width // 2, gray.height // 2))
    assert r == g == b
    assert turned.getpixel((0, 0)) == (255, 255, 255)
    assert [side for side, _ in views_of(Image.new("RGB", (800, 400)), "combined")] == ["obverse", "reverse"]
    assert views_of(Image.new("RGB", (500, 400)), "combined") == []


def test_side_key_gives_types_with_the_same_obverse_one_label():
    key = records.side_key
    a = key("ocre/a", "obverse", "denarius", "Head of Trajan, laureate, right", "trajan", "IMP TRAIANO AVG")
    b = key("ocre/b", "obverse", "denarius", "Head of Trajan, laureate, right.", "trajan", "IMP TRAIANO AVG")
    assert a == b
    assert key("ocre/a", "reverse", "denarius", "Victory standing left", "COS V") != \
        key("ocre/b", "reverse", "denarius", "Pax standing left", "COS V")
    assert key("ocre/c", "reverse", "denarius", None, "COS V") == "ocre/c|reverse"


def _photo_specimens(tmp_path, n=6):
    """A few made-up coins with photos on disk: two per type, in the gallery collection."""
    from solidi_ml.download import image_path
    specimens = []
    for i in range(n):
        s = records.Specimen(id=f"s{i}", collection="ans", type_id=f"T{i // 2}", design=f"T{i // 2}",
                             obverse_class=f"o{i // 2}", reverse_class=f"r{i // 2}", denomination="as")
        for side in ("obverse", "reverse"):
            photo = records.Photo(f"{i:02d}{side[0]}".ljust(16, "0"), s.id, side, "")
            path = image_path(tmp_path / "images", photo.key)
            path.parent.mkdir(parents=True, exist_ok=True)
            shade = 60 + 30 * (i // 2)
            _coin_picture(box=(120 + 5 * i, 80, 240 + 5 * i, 200)).point(lambda v: min(v, 255 - shade)).save(path)
            s.photos.append(photo)
        specimens.append(s)
    return specimens


def test_crops_are_cut_once_and_remembered(tmp_path):
    from solidi_ml import crops
    specimens = _photo_specimens(tmp_path)
    views = crops.prepare(specimens, tmp_path, workers=0, log=lambda *_: None)
    assert len(views) == 12 and all(v.found and v.path.exists() for v in views)
    assert Image.open(views[0].path).size == (crops.SIZE, crops.SIZE)
    stamp = views[0].path.stat().st_mtime_ns
    again = crops.prepare(specimens, tmp_path, workers=0, log=lambda *_: None)
    assert again == views and views[0].path.stat().st_mtime_ns == stamp      # nothing cut twice


def test_embedding_resumes_from_saved_blocks(tmp_path, monkeypatch):
    import torch
    from solidi_ml import crops, embed
    specimens = _photo_specimens(tmp_path)
    views = crops.prepare(specimens, tmp_path, workers=0, log=lambda *_: None)
    monkeypatch.setattr(embed, "BLOCK", 5)                  # 12 views: blocks of 5, 5 and 2
    calls = []

    class Tiny(torch.nn.Module):
        def forward(self, x):
            calls.append(len(x))
            return x.mean(dim=(2, 3))

    quiet = dict(model=Tiny(), tag="t", resolution=32, batch_size=4, device="cpu", workers=0, log=lambda *_: None)
    first = embed.embed(views, tmp_path, **quiet)
    assert first.shape == (12, 3) and sum(calls) == 12
    (tmp_path / "embeddings" / "t-32" / "block-0001.npy").unlink()      # as if the run had stopped here
    calls.clear()
    second = embed.embed(views, tmp_path, **quiet)
    assert sum(calls) == 7                                  # only the views from the missing block on
    assert (first == second).all()


def test_embedding_halves_the_batch_when_memory_runs_out(tmp_path):
    import torch
    from solidi_ml import crops, embed
    views = crops.prepare(_photo_specimens(tmp_path), tmp_path, workers=0, log=lambda *_: None)

    class Small(torch.nn.Module):
        def forward(self, x):
            if len(x) > 2:
                raise torch.OutOfMemoryError("CUDA out of memory")
            return x.mean(dim=(2, 3))

    vectors = embed.embed(views, tmp_path, model=Small(), tag="s", resolution=32, batch_size=8,
                          device="cpu", workers=0, log=lambda *_: None)
    assert vectors.shape == (12, 3)


def test_training_saves_and_resumes(tmp_path, monkeypatch):
    import torch
    from solidi_ml import train
    specimens = _photo_specimens(tmp_path)

    class Tiny(torch.nn.Module):
        num_features = 3

        def __init__(self):
            super().__init__()
            self.mix = torch.nn.Linear(3, 3)

        def forward(self, x):
            return self.mix(x.mean(dim=(2, 3)))

    monkeypatch.setattr(train, "load_model", lambda *a, **k: Tiny())
    settings = train.Settings(resolution=32, epochs=1, batch_size=4)
    quiet = dict(device="cpu", workers=0, log=lambda *_: None)
    history = train.train(specimens, tmp_path, tmp_path / "run", settings, **quiet)
    assert [row["epoch"] for row in history] == [0, 1] and history[1]["loss"] > 0
    assert (tmp_path / "run" / "best.pt").exists() and "| 1 |" in (tmp_path / "run" / "report.md").read_text()
    # Asking for one more pass picks up after pass 1 rather than starting again.
    settings.epochs = 2
    history = train.train(specimens, tmp_path, tmp_path / "run", settings, **quiet)
    assert [row["epoch"] for row in history] == [0, 1, 2]
