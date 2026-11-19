"""Flag photos our pages can't load (data/sources.yaml unusable_image_hosts) as image.usable = 0."""

from __future__ import annotations

import sqlite3


def flag_unusable(db: sqlite3.Connection, config: dict, log=print) -> int:
    hosts = [h["host"] for h in config.get("unusable_image_hosts") or []]
    db.execute("UPDATE image SET usable = 1")
    n = 0
    for host in hosts:
        n += db.execute("UPDATE image SET usable = 0 WHERE url LIKE ? OR thumbnail_url LIKE ?",
                        (f"%{host}%", f"%{host}%")).rowcount
    db.commit()
    log(f"  {n:,} images on unusable hosts ({', '.join(hosts)})")
    return n
