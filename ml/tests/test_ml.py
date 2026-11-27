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
    text = evaluate.markdown({"dataset": "d", "model": "m", "resolution": 224, "coin_found": found, **report})
    assert "Held-out collections" in text and "Design top 10" in text


def test_doubtful_labels_are_graded_apart():
    specimens = [_specimen("a1", "ans", "A"), _specimen("a2", "ans", "A"),
                 _specimen("good", "princeton", "A"), _specimen("bad", "princeton", "A")]
    specimens[3].corpus = "crro"                    # Princeton's Republican coins are doubtful
    assert specimens[3].doubtful and not specimens[2].doubtful
    views = [(s.id, side) for s in specimens for side in ("obverse", "reverse")]
    report = evaluate.evaluate(specimens, views, np.ones((8, 2), dtype=np.float32), log=lambda *_: None)
    assert report["held_out"]["queries"] == 1 and report["doubtful"]["queries"] == 1
    text = evaluate.markdown({"dataset": "d", "model": "m", "resolution": 224, "coin_found": {}, **report})
    assert "Held-out coins with doubtful labels" in text and "crro coins at princeton" in text


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


def _photo_specimens_held_out(tmp_path):
    """Two more made-up coins, of the first two types, in a held-out collection."""
    from solidi_ml.download import image_path
    specimens = []
    for i in range(2):
        s = records.Specimen(id=f"h{i}", collection="princeton", type_id=f"T{i}", design=f"T{i}",
                             obverse_class=f"o{i}", reverse_class=f"r{i}", denomination="as", corpus="ocre")
        for side in ("obverse", "reverse"):
            photo = records.Photo(f"h{i}{side[0]}".ljust(16, "0"), s.id, side, "")
            path = image_path(tmp_path / "images", photo.key)
            path.parent.mkdir(parents=True, exist_ok=True)
            _coin_picture(box=(130, 90, 250, 210)).point(lambda v: min(v, 195 - 30 * i)).save(path)
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
    settings = train.Settings(resolution=48, epochs=1, batch_size=4)    # not the default: grading must follow it
    quiet = dict(device="cpu", workers=0, log=lambda *_: None)
    history = train.train(specimens, tmp_path, tmp_path / "run", settings, **quiet)
    assert [row["epoch"] for row in history] == [0, 1] and history[1]["loss"] > 0
    assert (tmp_path / "run" / "best.pt").exists() and "| 1 |" in (tmp_path / "run" / "report.md").read_text()
    # Asking for one more pass picks up after pass 1 rather than starting again.
    settings.epochs = 2
    history = train.train(specimens, tmp_path, tmp_path / "run", settings, **quiet)
    assert [row["epoch"] for row in history] == [0, 1, 2]


def test_dataset_is_unpacked_once_and_when_replaced(tmp_path):
    import gzip, os, sqlite3
    import pytest
    from solidi_ml import dataset
    with pytest.raises(SystemExit, match="solidi training-data"):
        dataset.locate(tmp_path, log=lambda *_: None)
    raw = tmp_path / "raw.sqlite"
    db = sqlite3.connect(raw)
    db.executescript("""CREATE TABLE readme (key TEXT, value TEXT); CREATE TABLE specimen (id TEXT, dataset_id TEXT);
                        INSERT INTO readme VALUES ('built_at', '2026-11-22T04:48:25+00:00');
                        INSERT INTO specimen VALUES ('a', 'ans'), ('b', 'ans'), ('c', 'vienna');""")
    db.commit(); db.close()
    packed = tmp_path / "dataset.sqlite.gz"
    packed.write_bytes(gzip.compress(raw.read_bytes()))
    found = dataset.locate(tmp_path, log=lambda *_: None)
    assert dataset.describe(found) == "built 2026-11-22, 2 collections"
    stamp = found.stat().st_mtime_ns
    assert dataset.locate(tmp_path, log=lambda *_: None).stat().st_mtime_ns == stamp     # not unpacked twice
    os.utime(packed, (found.stat().st_mtime + 10, found.stat().st_mtime + 10))            # a newer copy arrives
    assert dataset.locate(tmp_path, log=lambda *_: None).stat().st_mtime_ns != stamp


def test_distillation_loss_rewards_agreeing_with_the_teacher():
    import torch
    from torch.nn.functional import normalize
    from solidi_ml import distil
    torch.manual_seed(0)
    s = distil.Settings(teacher_temperature=0.1)
    teacher = normalize(torch.randn(4, 8), dim=1)
    anchors = normalize(torch.randn(4, 5, 8), dim=2)
    same = distil.loss(teacher.clone(), teacher, anchors, s)
    other = distil.loss(normalize(torch.randn(4, 8), dim=1), teacher, anchors, s)
    opposite = distil.loss(-teacher, teacher, anchors, s)
    assert same < other < opposite
    # With the neighbourhood term off, a student that matches the teacher exactly loses nothing.
    assert distil.loss(teacher.clone(), teacher, anchors, distil.Settings(context_weight=0)).item() < 1e-6


def test_nearest_lists_each_row_first():
    import torch
    from solidi_ml.distil import nearest
    vectors = torch.eye(4)[[0, 0, 1, 2]] + torch.tensor([[0, 0, 0, 0.0], [0, 0.1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
    vectors = torch.nn.functional.normalize(vectors, dim=1)
    found = nearest(vectors, 2, "cpu")
    assert found[:, 0].tolist() == [0, 1, 2, 3] and found[0, 1] == 1 and found[1, 1] == 0


def test_distillation_trains_grades_three_ways_and_resumes(tmp_path, monkeypatch):
    import torch
    from solidi_ml import distil, embed
    specimens = _photo_specimens(tmp_path) + _photo_specimens_held_out(tmp_path)

    class Tiny(torch.nn.Module):
        def __init__(self, width):
            super().__init__()
            self.num_features = width
            self.mix = torch.nn.Linear(3, width)

        def forward(self, x):
            return self.mix(x.mean(dim=(2, 3)))

    torch.manual_seed(0)
    teacher_path = tmp_path / "big" / "best.pt"
    teacher_path.parent.mkdir()
    torch.save({"backbone": Tiny(6).state_dict(), "settings": {"model": "big", "resolution": 48}}, teacher_path)

    def tiny(name, resolution, device, weights=None):
        model = Tiny(6 if name == "big" else 4)
        if weights is not None:
            model.load_state_dict(torch.load(weights, weights_only=True)["backbone"])
        return model.eval()

    monkeypatch.setattr(distil, "load_model", tiny)
    monkeypatch.setattr(embed, "load_model", tiny)
    settings = distil.Settings(teacher=str(teacher_path), model="small", resolution=32, epochs=1,
                               batch_size=4, neighbours=3)
    quiet = dict(device="cpu", workers=0, log=lambda *_: None)
    history = distil.distil(specimens, tmp_path, tmp_path / "run", settings, **quiet)
    assert [row["epoch"] for row in history] == [0, 1]
    assert set(history[1]) == {"epoch", "loss", "mixed", "alone"} and "type_top10" in history[1]["mixed"]
    report = (tmp_path / "run" / "report.md").read_text()
    assert "The teacher alone" in report and "| 1 |" in report
    saved = torch.load(tmp_path / "run" / "best.pt", weights_only=True)
    assert saved["head"]["weight"].shape == (6, 4)             # the student's 4 numbers mapped to the teacher's 6
    settings.epochs = 2
    history = distil.distil(specimens, tmp_path, tmp_path / "run", settings, **quiet)
    assert [row["epoch"] for row in history] == [0, 1, 2]
    # The saved-teacher variant runs too, without loading the teacher network.
    cached = distil.Settings(teacher=str(teacher_path), model="small", resolution=32, epochs=1,
                             batch_size=4, neighbours=3, cached_teacher=True)
    assert len(distil.distil(specimens, tmp_path, tmp_path / "cached", cached, **quiet)) == 2


def _index_fixture(types=12, coins=6, width=32):
    """Coins whose two sides sit near their type's centre: 'ans' in the gallery, 'fralin' held out."""
    rng = np.random.default_rng(0)
    centres = rng.normal(size=(types, 2, width))
    specimens, views, vectors = [], [], []
    for t in range(types):
        for c in range(coins):
            s = records.Specimen(id=f"t{t}c{c}", collection="fralin" if c == 0 else "ans",
                                 type_id=f"type{t}", design=f"design{t // 2}")
            specimens.append(s)
            for i, side in enumerate(("obverse", "reverse")):
                views.append((s.id, side))
                vectors.append(centres[t, i] + 0.25 * rng.normal(size=width))
    vectors = np.array(vectors, dtype=np.float32)
    return specimens, views, vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def test_index_variants_shrink_the_gallery_and_still_find_coins():
    from solidi_ml import index
    specimens, views, vectors = _index_fixture()
    variants = (index.Variant(), index.Variant(code="int8"), index.Variant(code="bit"),
                index.Variant(dims=16, code="int8"), index.Variant(dims=16, code="pq4"),
                index.Variant(coins=2), index.Variant(coins="mean", dims=16, code="int8"))
    report = index.measure(specimens, views, vectors, vectors, variants, device="cpu", log=lambda _: None)
    rows = report["variants"]
    assert report["queries"] == 12 and rows[0]["kept"] == 60
    assert rows[0]["bytes"] == 60 * (2 * 32 * 4 + 4)
    assert rows[1]["bytes"] == 60 * (2 * 32 + 4) + 4
    assert rows[2]["bytes"] == 60 * (2 * 4 + 4)
    assert rows[4]["bytes"] == 60 * (2 * 4 + 4) + 256 * 16 * 4
    assert rows[5]["kept"] == 24 and rows[6]["kept"] == 12
    assert all(row["type_top1"] >= 0.9 for row in rows)      # the types are far apart
    assert "| type average | 12 | 16 | int8 |" in index.markdown(
        {"dataset": "d", "gallery_model": "a", "query_model": "b", **report})


def test_turning_keeps_what_matters_and_quantising_stays_close():
    import torch
    from solidi_ml import index
    _, _, vectors = _index_fixture()
    vectors = torch.from_numpy(vectors)
    mean, directions = index.fit_turn(vectors, "cpu")
    whole = index.turn(vectors, mean, directions, 32)
    centred = torch.nn.functional.normalize(vectors - mean, dim=1)
    assert torch.allclose(whole @ whole.T, centred @ centred.T, atol=1e-4)   # a turn, nothing lost
    patterns, codes = index.quantise(whole, 8, "cpu")
    assert patterns.shape[::2] == (8, 4) and codes.shape == (len(whole), 8)
    coded = index.read_back(patterns, codes)
    assert (torch.nn.functional.normalize(coded, dim=1) * whole).sum(dim=1).mean() > 0.8


def test_index_file_reads_back_what_was_written(tmp_path):
    import torch
    from solidi_ml import export, index
    vectors = torch.nn.functional.normalize(torch.randn(40, 16, generator=torch.Generator().manual_seed(0)), dim=1)
    patterns, codes = index.quantise(vectors, 4, "cpu")
    export.write_index(tmp_path, [f"type{i}" for i in range(20)], patterns, codes)
    types, stored = export.read_index(tmp_path)
    assert types[3] == "type3" and torch.equal(stored, index.read_back(patterns, codes))
    assert (tmp_path / "index.bin").stat().st_size == 4 * 40 * 4 * 4 + 40 * 4


def test_exported_models_agree_with_the_original(tmp_path):
    import torch
    from solidi_ml import export
    torch.manual_seed(0)
    network = torch.nn.Sequential(torch.nn.Flatten(), torch.nn.Linear(3 * 8 * 8, 96), torch.nn.GELU(),
                                  torch.nn.Linear(96, 48))
    model = export.Browser(network, torch.zeros(48), torch.linalg.qr(torch.randn(48, 48)).Q[:, :16])
    export.to_onnx(model, tmp_path / "model.onnx", 8)
    export.halve(tmp_path / "model.onnx", tmp_path / "half.onnx")
    export.shrink_weights(tmp_path / "model.onnx", tmp_path / "small.onnx")
    pictures = []
    for i in range(5):       # five pictures: the batch size is free
        pictures.append(tmp_path / f"{i}.png")
        Image.fromarray(np.random.default_rng(i).integers(0, 255, (8, 8, 3), dtype=np.uint8)).save(pictures[-1])
    from solidi_ml.embed import to_tensor
    with torch.no_grad():
        wanted = model(torch.stack([to_tensor(Image.open(p), 8) for p in pictures])).numpy()
    for name, close in (("model", 0.9999), ("half", 0.999), ("small", 0.99)):
        given = export.run_onnx(tmp_path / f"{name}.onnx", pictures, 8)
        assert given.shape == (5, 16) and (given * wanted).sum(axis=1).min() > close
    assert (tmp_path / "small.onnx").stat().st_size < 0.5 * (tmp_path / "model.onnx").stat().st_size
