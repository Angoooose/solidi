-- Solidi canonical schema. The database is rebuilt from scratch on every run,
-- so there are no migrations: change this file and rebuild.
PRAGMA foreign_keys = ON;

-- Where rows came from, and the licence switch.
CREATE TABLE dataset (
  id            TEXT PRIMARY KEY,          -- Nomisma dataset URI
  slug          TEXT UNIQUE,               -- 'ocre': prefix of the dataset's type IDs; NULL for specimen-only datasets
  name          TEXT,
  data_licence  TEXT,
  image_licence TEXT,                      -- stricter image terms where known
  commercial_ok INTEGER NOT NULL           -- 0/1, filter for a commercial build
);

CREATE TABLE build_info (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Reference data. Nomisma concepts keep Nomisma's own slug as ID ('trajan', 'rome'): Nomisma is
-- the shared registry. Entities from elsewhere get a source prefix ('cn/monogram.840').
-- `source` names the registry the URI belongs to ('nomisma', 'cn', ...).
CREATE TABLE person (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  definition  TEXT,
  start_year  INTEGER,                     -- earliest office held (negative = BC)
  end_year    INTEGER,
  birth_year  INTEGER,
  death_year  INTEGER
);

-- Groups that issue coins: peoples, states (e.g. Visigothic imitations in RIC X).
CREATE TABLE organization (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  definition  TEXT
);

-- Headings for browsing city coinage by region, in catalogue order (data/regions.yaml).
CREATE TABLE region_group (
  id          TEXT PRIMARY KEY,            -- 'asia-minor'
  name        TEXT NOT NULL,               -- 'Asia Minor'
  sort_order  INTEGER NOT NULL
);

-- Geographic regions, nested (Latium within Greek Italy). Greek coinage is browsed by region.
CREATE TABLE region (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  definition  TEXT,
  parent_id   TEXT REFERENCES region(id),
  lat         REAL,
  lon         REAL,
  group_id    TEXT REFERENCES region_group(id), -- its heading; NULL for regions no type uses
  sort_order  INTEGER                      -- order within the heading
);

CREATE TABLE mint (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  definition  TEXT,
  parent_id   TEXT REFERENCES mint(id),    -- a workshop's city mint (Seleucia on the Tigris II -> Seleucia)
  region_id   TEXT REFERENCES region(id),
  lat         REAL,                        -- NULL for most workshops: use the parent mint's
  lon         REAL
);

CREATE TABLE denomination (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  definition  TEXT
);

CREATE TABLE material (
  id          TEXT PRIMARY KEY,
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL
);

CREATE TABLE subject (
  id          TEXT PRIMARY KEY,
  uri         TEXT UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- 'deity', 'other'
  definition  TEXT
);

-- Monograms, control marks and symbols in the field: key evidence for Hellenistic coinage.
CREATE TABLE symbol (
  id          TEXT PRIMARY KEY,            -- 'pella/monogram.price.453'
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,               -- the source ID when the source publishes no record
  definition  TEXT,
  published   INTEGER NOT NULL,            -- 0: the type cites it but the source has no record of it
  image_url   TEXT,                        -- SVG drawing where the source has one
  letters     TEXT                         -- letters a monogram is made of, space-separated
);

-- Published catalogues a type belongs to or is cited in (RIC, RRC, Price 1991...).
CREATE TABLE reference_work (
  id          TEXT PRIMARY KEY,            -- Nomisma slug: 'ric', 'rrc', 'price1991'
  uri         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL                -- 'Roman Imperial Coinage'
);

-- Collector categories, nested: Roman > Imperial; Greek > Hellenistic > Seleucid.
-- Defined in data/categories.yaml; types are placed by rules there, not by catalogue.
CREATE TABLE category (
  id          TEXT PRIMARY KEY,            -- 'roman-imperial'
  parent_id   TEXT REFERENCES category(id),
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL
);

-- Links from our entities to Wikidata, Pleiades, VIAF, Getty...
CREATE TABLE external_id (
  entity_type TEXT NOT NULL,               -- 'person', 'mint', 'region', 'denomination', 'subject'
  entity_id   TEXT NOT NULL,
  system      TEXT NOT NULL,               -- 'wikidata', 'pleiades', 'viaf', 'getty', 'other'
  uri         TEXT NOT NULL,
  match_type  TEXT NOT NULL,               -- 'exact', 'close'
  method      TEXT NOT NULL,               -- 'source', 'wikidata_p2950', 'automatic', 'reviewed'
  PRIMARY KEY (entity_type, entity_id, uri)
);

-- Family links between people we hold (from Wikidata).
CREATE TABLE person_relation (
  person_id         TEXT NOT NULL REFERENCES person(id),
  relation          TEXT NOT NULL,         -- 'father', 'mother', 'spouse', 'child'
  related_person_id TEXT NOT NULL REFERENCES person(id),
  PRIMARY KEY (person_id, relation, related_person_id)
);

-- English Wikipedia article for an entity, via its Wikidata item.
CREATE TABLE wikipedia_link (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  qid         TEXT NOT NULL,
  url         TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- Encyclopedic text about an entity. Wikipedia text is CC BY-SA: show title, link and licence.
CREATE TABLE article (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  source       TEXT NOT NULL,              -- 'wikipedia_en' (later: our own writing)
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  extract      TEXT NOT NULL,
  revision     TEXT,
  retrieved_at TEXT,                       -- the article revision's timestamp
  licence      TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, source)
);

-- The centre.
CREATE TABLE coin_type (
  id              TEXT PRIMARY KEY,        -- '{dataset slug}/{source ID}': 'ocre/ric.2.tr.147'
  source_uri      TEXT NOT NULL UNIQUE,
  dataset_id      TEXT NOT NULL REFERENCES dataset(id),
  title           TEXT,                    -- the source's label: 'RIC II Trajan 147'
  parent_id       TEXT REFERENCES coin_type(id),
  replaced_by_id  TEXT,                    -- may point outside the build slice
  start_year      INTEGER,
  end_year        INTEGER,
  mint_id         TEXT REFERENCES mint(id),
  mint_uncertain  INTEGER NOT NULL DEFAULT 0,
  obv_legend      TEXT,
  obv_description TEXT,
  rev_legend      TEXT,
  rev_description TEXT
);

-- Catalogue references. One per type for now (the type's own catalogue, is_primary = 1);
-- concordances to other catalogues will add more.
CREATE TABLE type_reference (
  type_id     TEXT NOT NULL REFERENCES coin_type(id),
  work_id     TEXT NOT NULL REFERENCES reference_work(id),
  label       TEXT NOT NULL,               -- as cited: 'RIC II Trajan 147'
  volume      TEXT,                        -- 'RIC II', 'RIC II, Part 3 (second edition)'
  number      TEXT,                        -- '147', '10-11', '414/1'
  sort_key    TEXT NOT NULL,               -- orders references naturally within a work
  is_primary  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type_id, work_id, label)
);

-- Types the source says are the same as, or correspond to, another type (case variants,
-- a later edition's number). target_type_id is set when the other type is in the build.
CREATE TABLE type_match (
  type_id        TEXT NOT NULL REFERENCES coin_type(id),
  uri            TEXT NOT NULL,
  relation       TEXT NOT NULL,            -- 'exact'
  target_type_id TEXT REFERENCES coin_type(id),
  PRIMARY KEY (type_id, uri)
);

CREATE TABLE type_category (
  type_id     TEXT NOT NULL REFERENCES coin_type(id),
  category_id TEXT NOT NULL REFERENCES category(id),
  is_primary  INTEGER NOT NULL DEFAULT 1,
  method      TEXT NOT NULL,               -- 'rule' (data/categories.yaml), later 'reviewed'
  PRIMARY KEY (type_id, category_id)
);

CREATE TABLE type_region (
  type_id   TEXT NOT NULL REFERENCES coin_type(id),
  region_id TEXT NOT NULL REFERENCES region(id),
  PRIMARY KEY (type_id, region_id)
);

CREATE TABLE type_symbol (
  type_id   TEXT NOT NULL REFERENCES coin_type(id),
  side      TEXT NOT NULL,                 -- 'obverse', 'reverse'
  symbol_id TEXT NOT NULL REFERENCES symbol(id),
  uncertain INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type_id, side, symbol_id)
);

-- Some types list more than one denomination or material.
CREATE TABLE type_denomination (
  type_id         TEXT NOT NULL REFERENCES coin_type(id),
  denomination_id TEXT NOT NULL REFERENCES denomination(id),
  PRIMARY KEY (type_id, denomination_id)
);

CREATE TABLE type_material (
  type_id     TEXT NOT NULL REFERENCES coin_type(id),
  material_id TEXT NOT NULL REFERENCES material(id),
  PRIMARY KEY (type_id, material_id)
);

CREATE TABLE type_person (
  type_id   TEXT NOT NULL REFERENCES coin_type(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  role      TEXT NOT NULL,                 -- 'authority', 'stated_authority', 'issuer', 'portrait_obverse', 'portrait_reverse'
  PRIMARY KEY (type_id, person_id, role)
);

CREATE TABLE type_organization (
  type_id         TEXT NOT NULL REFERENCES coin_type(id),
  organization_id TEXT NOT NULL REFERENCES organization(id),
  role            TEXT NOT NULL,           -- 'authority', 'stated_authority', 'issuer'
  PRIMARY KEY (type_id, organization_id, role)
);

CREATE TABLE type_subject (
  type_id    TEXT NOT NULL REFERENCES coin_type(id),
  subject_id TEXT NOT NULL REFERENCES subject(id),
  side       TEXT NOT NULL,                -- 'obverse', 'reverse'
  method     TEXT NOT NULL,                -- 'source', 'keyword', 'llm'
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (type_id, subject_id, side)
);

-- Legends for search: the source text, a normalised form, and a space-free form.
CREATE TABLE legend (
  id         INTEGER PRIMARY KEY,
  type_id    TEXT NOT NULL REFERENCES coin_type(id),
  side       TEXT NOT NULL,                -- 'obverse', 'reverse'
  position   TEXT,                         -- where on the side, when the source says ('exergue', 'left field')
  language   TEXT NOT NULL,                -- 'la', 'grc'
  legend     TEXT NOT NULL,                -- as written by the source
  normalised TEXT NOT NULL,                -- 'D N HONORIVS P F AVG'
  compact    TEXT NOT NULL,                -- 'DNHONORIVSPFAVG'
  romanised  TEXT,                         -- search key in Latin letters, for non-Latin legends ('MAHARAIASA...')
  transliteration TEXT,                    -- readable transliteration for display ('maharajasa tratarasa menadrasa')
  segments   TEXT,                         -- JSON: [{text, latin, english, kind, number?}, ...]
  expanded_latin TEXT,                     -- 'Dominus Noster Honorius Pius Felix Augustus'
  english    TEXT,                         -- 'Our Lord · Honorius · dutiful and fortunate · Augustus'
  gloss_coverage REAL                      -- share of words the dictionary explained (0-1)
);
CREATE INDEX idx_legend_type ON legend(type_id);

-- Trigram index: fast spacing-insensitive fragment search with LIKE, in the legend's own
-- script and romanised.
CREATE VIRTUAL TABLE legend_fts USING fts5(compact, romanised, content='legend', content_rowid='id', tokenize='trigram');

-- Word index over the expansion and glosses: search legends by meaning.
CREATE VIRTUAL TABLE legend_meaning_fts USING fts5(expanded_latin, english, content='legend',
                                                   content_rowid='id', tokenize='unicode61 remove_diacritics 2');

-- Evidence.
CREATE TABLE institution (
  id          TEXT PRIMARY KEY,
  uri         TEXT UNIQUE,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL
);

CREATE TABLE specimen (
  id             TEXT PRIMARY KEY,         -- short hash of source URI
  source_uri     TEXT NOT NULL UNIQUE,
  dataset_id     TEXT REFERENCES dataset(id),
  institution_id TEXT REFERENCES institution(id),
  identifier     TEXT,
  title          TEXT,
  weight_g       REAL,
  diameter_mm    REAL,
  die_axis       INTEGER
);

-- A specimen can be attributed to more than one type.
CREATE TABLE specimen_type (
  specimen_id TEXT NOT NULL REFERENCES specimen(id),
  type_id     TEXT NOT NULL REFERENCES coin_type(id),
  link_method TEXT NOT NULL,               -- 'source', 'normalised_uri', 'redirected'
  PRIMARY KEY (specimen_id, type_id)
);

CREATE TABLE image (
  id            INTEGER PRIMARY KEY,
  specimen_id   TEXT NOT NULL REFERENCES specimen(id),
  side          TEXT NOT NULL,             -- 'obverse', 'reverse', 'combined'
  url           TEXT NOT NULL,
  thumbnail_url TEXT,
  iiif_service  TEXT,
  usable        INTEGER NOT NULL DEFAULT 1, -- 0: browsers can't load it from our pages (sources.yaml)
  UNIQUE (specimen_id, side, url)
);

CREATE INDEX idx_type_mint ON coin_type(mint_id);
CREATE INDEX idx_type_dataset ON coin_type(dataset_id);
CREATE INDEX idx_mint_region ON mint(region_id);
CREATE INDEX idx_type_reference_work ON type_reference(work_id, sort_key);
CREATE INDEX idx_type_category_category ON type_category(category_id);
CREATE INDEX idx_type_region_region ON type_region(region_id);
CREATE INDEX idx_type_symbol_symbol ON type_symbol(symbol_id);
CREATE INDEX idx_type_denomination_denom ON type_denomination(denomination_id);
CREATE INDEX idx_type_parent ON coin_type(parent_id);
CREATE INDEX idx_type_person_person ON type_person(person_id);
CREATE INDEX idx_type_subject_subject ON type_subject(subject_id);
CREATE INDEX idx_specimen_type_type ON specimen_type(type_id);
CREATE INDEX idx_image_specimen ON image(specimen_id);
