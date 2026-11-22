"""Flag photos our pages don't show as image.usable = 0 (data/sources.yaml): those on hosts our
pages can't load (unusable_image_hosts) and those from hidden collections (hidden_image_datasets)."""

from __future__ import annotations

import sqlite3


def flag_unusable(db: sqlite3.Connection, config: dict, log=print) -> int:
    hosts = [h["host"] for h in config.get("unusable_image_hosts") or []]
    db.execute("UPDATE image SET usable = 1")
    n = 0
    for host in hosts:
        n += db.execute("UPDATE image SET usable = 0 WHERE url LIKE ? OR thumbnail_url LIKE ?",
                        (f"%{host}%", f"%{host}%")).rowcount
    log(f"  {n:,} images on unusable hosts ({', '.join(hosts)})")
    datasets = [d["id"] for d in config.get("hidden_image_datasets") or []]
    hidden = 0
    for dataset in datasets:
        hidden += db.execute("""UPDATE image SET usable = 0 WHERE usable = 1 AND specimen_id IN
                                  (SELECT id FROM specimen WHERE dataset_id = ?)""", (dataset,)).rowcount
    db.commit()
    log(f"  {hidden:,} images from {len(datasets)} hidden collections")
    return n + hidden
