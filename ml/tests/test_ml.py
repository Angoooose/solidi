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
    assert held["type"]["both"] == {"top1": 0.5, "top5": 1.0, "top10": 1.0}   # qa first, qc second
    assert held["design"]["both"]["top1"] == 1.0    # qc's nearest coin is type B: the same design
    assert held["labels"]["portrait"] == {"queries": 2, "top1": 0.5}
    # Same collection: only a1 and a2 have another coin of their type. Each must find the other,
    # not itself, so both rank first.
    same = report["same_collection"]
    assert same["queries"] == 2
    assert same["type"]["both"]["top1"] == 1.0
    assert same["by_bucket"] == {"1": {"queries": 2, "top1": 1.0, "top5": 1.0, "top10": 1.0,
                                       "design_top10": 1.0}}
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


def test_prepare_variants_keep_the_square():
    from solidi_ml.embed import prepare, views_of
    picture = _coin_picture()
    plain, gray, turned = (prepare(picture)[0], prepare(picture, gray=True)[0],
                           prepare(picture, angle=45)[0])
    assert plain.size == gray.size == turned.size
    r, g, b = gray.getpixel((gray.width // 2, gray.height // 2))
    assert r == g == b
    assert turned.getpixel((0, 0)) == (255, 255, 255)
    assert [side for side, _ in views_of(Image.new("RGB", (800, 400)), "combined")] == ["obverse", "reverse"]
    assert views_of(Image.new("RGB", (500, 400)), "combined") == []
