"""What the release says about each photographed coin: its photos, its type and its coarse labels.

A "specimen" is one physical coin. Its type is the label we want to predict; the portrait,
denomination and mint are coarser labels that should be easier.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

# Short names for the collections (keys are the release's dataset ids).
COLLECTIONS = {
    "http://numismatics.org/search/": "ans",
    "https://numismatics.org/sitnam/": "sitnam",
    "https://finds.org.uk/": "pas",
    "https://catalog.princeton.edu/numismatics": "princeton",
    "https://exploratorium.galloromeinsmuseum.be/": "tongeren",
    "https://coins.lib.virginia.edu/": "fralin",
    "https://www.artic.edu/": "artic",
    "https://muenzen.uni-koeln.de": "cologne",
    "https://coins.cealex.org:443/": "cealex",
    "http://www.metmuseum.org/": "met",
    "https://libguides.furman.edu/digital-collections/coins-collection": "furman",
}

# In the release, but left out here.
EXCLUDED = {
    "http://bnf.fr/": "CC BY on the data, but the BnF disputes reuse of its photographs",
}

# The collections we search in (and later train on). Every other collection is held out whole, so
# a test coin never shares a photographer, background or lighting setup with the gallery.
GALLERY = ("ans", "sitnam")


# Held-out coins whose type links can't be trusted, by (catalogue, collection). They are graded
# apart from the rest, so a wrong label in the source isn't counted as the model's mistake.
DOUBTFUL = {
    ("crro", "princeton"): "many are linked to a neighbouring catalogue number: of 26 compared by "
                           "eye with ANS coins of the same type, about 10 were a different coin",
    ("sco", "princeton"): "not checked; scores as low as Princeton's Republican coins",
}


@dataclass(frozen=True)
class Photo:
    key: str          # stable across releases: a hash of the source URL
    specimen_id: str
    side: str         # 'obverse', 'reverse' or 'combined' (both sides in one picture)
    url: str          # the address to download, sized where the host can resize


@dataclass
class Specimen:
    id: str
    collection: str
    type_id: str
    corpus: str | None = None        # the catalogue the type belongs to: 'ocre', 'crro'...
    portrait: str | None = None      # who is on the obverse
    denomination: str | None = None
    mint: str | None = None
    design: str = ""                 # types that look alike share one: see `design_key`
    obverse_class: str = ""          # what training calls this side: see `side_key`
    reverse_class: str = ""
    photos: list[Photo] = field(default_factory=list)

    def label(self, name: str) -> str | None:
        return getattr(self, name)

    @property
    def doubtful(self) -> bool:
        return (self.corpus, self.collection) in DOUBTFUL


def _plain(text: str) -> str:
    text = re.sub(r"border of dots|[^a-z0-9 ]", " ", text.lower())
    return " ".join(text.split())


def design_key(type_id: str, portrait: str | None, denomination: str | None,
               obverse: str | None, reverse: str | None) -> str:
    """A label shared by types a photograph can hardly tell apart: the same denomination, the same
    person on the obverse (or, with no portrait recorded, the same obverse description) and the
    same reverse description. Such types differ in legend breaks, mint marks or small symbols.
    A type missing a description stands alone."""
    front = portrait or _plain(obverse or "")
    back = _plain(reverse or "")
    if not front or not back:
        return type_id
    return f"{denomination or ''}|{front}|{back}"


def side_key(type_id: str, side: str, denomination: str | None, *shown: str | None) -> str:
    """The training label for one side of a coin: everything recorded about that side alone (who
    or what it shows, and its legend). Two types with the same obverse and different reverses
    share an obverse label, so the model is never asked to tell apart pictures that are the same.
    A side with no description is labelled by its type."""
    parts = [_plain(text or "") for text in shown]
    if not parts[0]:
        return f"{type_id}|{side}"
    return "|".join([side, denomination or ""] + parts)


def photo_key(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def sized_url(url: str, iiif_service: str | None, size: int) -> str:
    """Ask an IIIF host for the picture fitted inside size x size; other hosts give what they give."""
    if iiif_service:
        return f"{iiif_service.rstrip('/')}/full/!{size},{size}/0/default.jpg"
    return url


def _collection(dataset_id: str) -> str:
    return COLLECTIONS.get(dataset_id) or dataset_id.split("//")[-1].strip("/").replace("/", "_")


def load(db_path: Path, size: int = 512) -> list[Specimen]:
    """Every usable specimen with at least one photo, in a stable order.

    Left out: excluded collections, and the few specimens attributed to more than one type
    (under 1%), whose label is ambiguous.
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    labels = {
        "portrait": dict(db.execute(
            """SELECT type_id, group_concat(person_id, '+') FROM
                 (SELECT type_id, person_id FROM type_person WHERE role = 'portrait_obverse'
                  ORDER BY type_id, person_id) GROUP BY type_id""")),
        "denomination": dict(db.execute(
            """SELECT type_id, group_concat(denomination_id, '+') FROM
                 (SELECT type_id, denomination_id FROM type_denomination
                  ORDER BY type_id, denomination_id) GROUP BY type_id""")),
    }
    types = {row[0]: row[1:] for row in db.execute(
        """SELECT t.id, d.slug, t.mint_id, t.obv_description, t.rev_description, t.obv_legend,
                  t.rev_legend
             FROM coin_type t LEFT JOIN dataset d ON d.id = t.dataset_id""")}
    specimens: dict[str, Specimen] = {}
    rows = db.execute(
        """SELECT s.id, s.dataset_id, st.type_id, i.side, i.url, i.iiif_service
             FROM specimen s
             JOIN (SELECT specimen_id, min(type_id) AS type_id FROM specimen_type
                   GROUP BY specimen_id HAVING count(*) = 1) st ON st.specimen_id = s.id
             JOIN image i ON i.specimen_id = s.id
            ORDER BY s.id, i.side, i.url""")
    for sid, dataset_id, type_id, side, url, iiif in rows:
        if dataset_id in EXCLUDED or dataset_id is None:
            continue
        specimen = specimens.get(sid)
        if specimen is None:
            corpus, mint, obverse, reverse, obv_legend, rev_legend = types.get(type_id, (None,) * 6)
            portrait = labels["portrait"].get(type_id)
            denomination = labels["denomination"].get(type_id)
            specimen = specimens[sid] = Specimen(
                id=sid, collection=_collection(dataset_id), type_id=type_id, corpus=corpus,
                portrait=portrait, denomination=denomination, mint=mint,
                design=design_key(type_id, portrait, denomination, obverse, reverse),
                obverse_class=side_key(type_id, "obverse", denomination, obverse, portrait, obv_legend),
                reverse_class=side_key(type_id, "reverse", denomination, reverse, rev_legend))
        if any(p.side == side for p in specimen.photos):
            continue   # one photo per side is enough
        specimen.photos.append(Photo(photo_key(url), sid, side, sized_url(url, iiif, size)))
    db.close()
    return list(specimens.values())


def sample_types(specimens: list[Specimen], n: int) -> list[Specimen]:
    """A small, repeatable slice for trying things out: n types that have a held-out coin as well
    as gallery coins, with all of their specimens."""
    in_gallery = {s.type_id for s in specimens if s.collection in GALLERY}
    held_out = {s.type_id for s in specimens if s.collection not in GALLERY}
    both = sorted(in_gallery & held_out, key=lambda t: hashlib.sha1(t.encode()).hexdigest())
    chosen = set(both[:n])
    return [s for s in specimens if s.type_id in chosen]
