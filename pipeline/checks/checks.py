"""Data checks run against the built database. Errors fail the build; warnings are reported."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field


@dataclass
class Result:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    coverage: dict[str, object] = field(default_factory=dict)


def _one(db: sqlite3.Connection, sql: str) -> int:
    return db.execute(sql).fetchone()[0]


def _pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


ACTIVE = "coin_type.replaced_by_id IS NULL"


def run(db: sqlite3.Connection) -> Result:
    r = Result()

    # Errors: structural problems that mean the build is wrong.
    fk = db.execute("PRAGMA foreign_key_check").fetchall()
    if fk:
        r.errors.append(f"{len(fk)} foreign-key violations, e.g. {fk[:3]}")
    if _one(db, "SELECT COUNT(*) FROM coin_type") == 0:
        r.errors.append("no coin types built")
    n = _one(db, "SELECT COUNT(*) FROM specimen WHERE id NOT IN (SELECT specimen_id FROM specimen_type)")
    if n:
        r.errors.append(f"{n} specimens are not linked to any type")
    n = _one(db, "SELECT COUNT(*) FROM image WHERE url IS NULL OR url = ''")
    if n:
        r.errors.append(f"{n} images without a URL")
    n = _one(db, "SELECT COUNT(*) FROM coin_type WHERE start_year > end_year")
    if n:
        r.errors.append(f"{n} types end before they start")
    for table in ("coin_type", "region", "category", "mint"):
        n = _one(db, f"""WITH RECURSIVE reach(id) AS (
                            SELECT id FROM {table} WHERE parent_id IS NULL
                            UNION SELECT c.id FROM {table} c JOIN reach ON c.parent_id = reach.id)
                         SELECT (SELECT COUNT(*) FROM {table}) - (SELECT COUNT(*) FROM reach)""")
        if n:
            r.errors.append(f"{n} {table} rows sit in a parent loop")
    n = _one(db, """SELECT COUNT(*) FROM coin_type WHERE id NOT IN
                    (SELECT type_id FROM type_reference WHERE is_primary = 1)""")
    if n:
        r.errors.append(f"{n} types have no primary catalogue reference")
    n = _one(db, """SELECT COUNT(*) FROM coin_type t JOIN dataset d ON d.id = t.dataset_id
                    WHERE t.id NOT LIKE d.slug || '/%'""")
    if n:
        r.errors.append(f"{n} type IDs do not start with their dataset slug")

    # Warnings: gaps worth knowing about, not build-breaking.
    # Republican coins name their moneyer (issuer), not an authority; posthumous Alexanders name
    # the king they were struck for (stated authority). Any of the three counts.
    roles = "('authority', 'stated_authority', 'issuer')"
    n = _one(db, f"""SELECT COUNT(*) FROM coin_type WHERE {ACTIVE}
                     AND id NOT IN (SELECT type_id FROM type_person WHERE role IN {roles})
                     AND id NOT IN (SELECT type_id FROM type_organization WHERE role IN {roles})""")
    if n:
        r.warnings.append(f"{n} active types have no authority or issuer in the source")
    n = _one(db, f"SELECT COUNT(*) FROM coin_type WHERE {ACTIVE} AND id NOT IN (SELECT type_id FROM type_category)")
    if n:
        r.warnings.append(f"{n} active types match no category rule")
    n = _one(db, """SELECT COUNT(*) FROM mint m LEFT JOIN mint p ON p.id = m.parent_id
                    WHERE m.lat IS NULL AND p.lat IS NULL""")
    if n:
        r.warnings.append(f"{n} mints have no coordinates, nor a parent mint with them")
    n = _one(db, f"SELECT COUNT(*) FROM coin_type WHERE {ACTIVE} AND mint_id IS NULL AND mint_uncertain = 0")
    if n:
        r.warnings.append(f"{n} active types have no mint")
    n = _one(db, f"""SELECT COUNT(*) FROM coin_type WHERE {ACTIVE} AND id NOT IN
                     (SELECT type_id FROM type_denomination)""")
    if n:
        r.warnings.append(f"{n} active types have no denomination")
    n = _one(db, """SELECT COUNT(*) FROM person
                    WHERE start_year IS NULL AND birth_year IS NULL AND death_year IS NULL""")
    if n:
        r.warnings.append(f"{n} people have no dates at all")
    n = _one(db, """SELECT COUNT(*) FROM person WHERE birth_year > death_year
                    OR death_year - birth_year > 110 OR birth_year > start_year""")
    if n:
        r.warnings.append(f"{n} people have impossible life dates")
    n = _one(db, "SELECT COUNT(*) FROM dataset WHERE name IS NULL")
    if n:
        r.warnings.append(f"{n} datasets referenced by specimens have no metadata")
    for key, value in db.execute("SELECT key, value FROM build_info WHERE key LIKE 'warning:%'"):
        r.warnings.append(f"{key.removeprefix('warning: ')}: {value}")

    # Coverage figures.
    types = _one(db, "SELECT COUNT(*) FROM coin_type")
    active = _one(db, f"SELECT COUNT(*) FROM coin_type WHERE {ACTIVE}")
    imaged_types = _one(db, f"""SELECT COUNT(DISTINCT st.type_id) FROM specimen_type st
                               JOIN coin_type ON coin_type.id = st.type_id AND {ACTIVE}
                               JOIN image i ON i.specimen_id = st.specimen_id""")
    imaged_types_commercial = _one(db, f"""SELECT COUNT(DISTINCT st.type_id) FROM specimen_type st
                               JOIN coin_type ON coin_type.id = st.type_id AND {ACTIVE}
                               JOIN image i ON i.specimen_id = st.specimen_id
                               JOIN specimen s ON s.id = st.specimen_id
                               JOIN dataset d ON d.id = s.dataset_id AND d.commercial_ok = 1""")
    subject_types = _one(db, f"""SELECT COUNT(DISTINCT type_id) FROM type_subject
                                JOIN coin_type ON coin_type.id = type_id AND {ACTIVE}""")
    specimens = _one(db, "SELECT COUNT(*) FROM specimen")
    r.coverage = {
        "types": types,
        "active_types": active,
        "deprecated_types": types - active,
        "active_types_with_image": imaged_types,
        "active_types_with_image_pct": _pct(imaged_types, active),
        "active_types_with_commercial_image": imaged_types_commercial,
        "active_types_with_commercial_image_pct": _pct(imaged_types_commercial, active),
        "active_types_with_subject_pct": _pct(subject_types, active),
        "specimens": specimens,
        "specimens_with_image": _one(db, "SELECT COUNT(DISTINCT specimen_id) FROM image"),
        "images": _one(db, "SELECT COUNT(*) FROM image"),
        "images_with_iiif": _one(db, "SELECT COUNT(*) FROM image WHERE iiif_service IS NOT NULL"),
        "people": _one(db, "SELECT COUNT(*) FROM person"),
        "people_with_wikidata_pct": _pct(_one(db, """SELECT COUNT(DISTINCT entity_id) FROM external_id
                                        WHERE entity_type='person' AND system='wikidata'"""),
                                        _one(db, "SELECT COUNT(*) FROM person")),
        "people_with_any_date_pct": _pct(_one(db, """SELECT COUNT(*) FROM person WHERE start_year IS NOT NULL
                                         OR birth_year IS NOT NULL OR death_year IS NOT NULL"""),
                                         _one(db, "SELECT COUNT(*) FROM person")),
        "family_relations": _one(db, "SELECT COUNT(*) FROM person_relation"),
        "entities_with_wikipedia": _one(db, "SELECT COUNT(*) FROM wikipedia_link"),
        "articles": {t: _pct(_one(db, f"SELECT COUNT(*) FROM article WHERE entity_type='{t}'"),
                             _one(db, f"SELECT COUNT(*) FROM {t}"))
                     for t in ("person", "mint", "region", "denomination", "subject", "organization")},
        "active_types_with_searchable_legend_pct": _pct(_one(db, f"""SELECT COUNT(DISTINCT type_id) FROM legend
                                         JOIN coin_type ON coin_type.id = type_id AND {ACTIVE}"""), active),
        "legend_words_glossed_pct": round(100 * (db.execute(
            """SELECT SUM(gloss_coverage * (LENGTH(normalised) - LENGTH(REPLACE(normalised, ' ', '')) + 1))
                      / SUM(LENGTH(normalised) - LENGTH(REPLACE(normalised, ' ', '')) + 1)
               FROM legend WHERE gloss_coverage IS NOT NULL""").fetchone()[0] or 0), 1),
        "legends_fully_glossed_pct": _pct(_one(db, "SELECT COUNT(*) FROM legend WHERE gloss_coverage = 1"),
                                          _one(db, "SELECT COUNT(*) FROM legend")),
        "mints": _one(db, "SELECT COUNT(*) FROM mint"),
        "mints_with_pleiades_pct": _pct(_one(db, """SELECT COUNT(DISTINCT entity_id) FROM external_id
                                       WHERE entity_type='mint' AND system='pleiades'"""),
                                       _one(db, "SELECT COUNT(*) FROM mint")),
        "mints_with_region_pct": _pct(_one(db, "SELECT COUNT(*) FROM mint WHERE region_id IS NOT NULL"),
                                      _one(db, "SELECT COUNT(*) FROM mint")),
        "regions": _one(db, "SELECT COUNT(*) FROM region"),
        "active_types_with_region_pct": _pct(_one(db, f"""SELECT COUNT(DISTINCT type_id) FROM type_region
                                         JOIN coin_type ON coin_type.id = type_id AND {ACTIVE}"""), active),
        "types_by_category": dict(db.execute("""SELECT c.id, COUNT(*) FROM type_category tc
                                   JOIN category c ON c.id = tc.category_id GROUP BY c.id""").fetchall()),
        "reference_works": dict(db.execute("""SELECT work_id, COUNT(*) FROM type_reference
                                   GROUP BY work_id""").fetchall()),
        "type_matches": _one(db, "SELECT COUNT(*) FROM type_match"),
        "type_matches_in_build": _one(db, "SELECT COUNT(*) FROM type_match WHERE target_type_id IS NOT NULL"),
        "symbols": _one(db, "SELECT COUNT(*) FROM symbol"),
        "symbols_published": _one(db, "SELECT COUNT(*) FROM symbol WHERE published = 1"),
        "active_types_with_symbol": _one(db, f"""SELECT COUNT(DISTINCT type_id) FROM type_symbol
                                     JOIN coin_type ON coin_type.id = type_id AND {ACTIVE}"""),
        "subjects": _one(db, "SELECT COUNT(*) FROM subject"),
        "institutions": _one(db, "SELECT COUNT(*) FROM institution"),
    }
    return r
