-- Solidi canonical schema. The database is rebuilt from scratch on every run,
-- so there are no migrations: change this file and rebuild.
PRAGMA foreign_keys = ON;

-- Where rows came from, and the licence switch.
CREATE TABLE dataset (
  id            TEXT PRIMARY KEY,          -- Nomisma dataset URI
  name          TEXT,
  data_licence  TEXT,
  image_licence TEXT,                      -- stricter image terms where known
  commercial_ok INTEGER NOT NULL           -- 0/1, filter for a commercial build
);

CREATE TABLE build_info (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Reference data. IDs are Nomisma's own slugs ('trajan', 'rome').
CREATE TABLE person (
  id          TEXT PRIMARY KEY,
  nomisma_uri TEXT NOT NULL UNIQUE,
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
  nomisma_uri TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  definition  TEXT
);

CREATE TABLE mint (
  id          TEXT PRIMARY KEY,
  nomisma_uri TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  definition  TEXT,
  lat         REAL,
  lon         REAL
);

CREATE TABLE denomination (
  id          TEXT PRIMARY KEY,
  nomisma_uri TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  definition  TEXT
);

CREATE TABLE material (
  id          TEXT PRIMARY KEY,
  nomisma_uri TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL
);

CREATE TABLE subject (
  id          TEXT PRIMARY KEY,
  nomisma_uri TEXT UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- 'deity', 'other'
  definition  TEXT
);

-- Links from our entities to Wikidata, Pleiades, VIAF, Getty...
CREATE TABLE external_id (
  entity_type TEXT NOT NULL,               -- 'person', 'mint', 'denomination', 'subject'
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

-- The centre.
CREATE TABLE coin_type (
  id              TEXT PRIMARY KEY,        -- 'ric.2.tr.147'
  source_uri      TEXT NOT NULL UNIQUE,
  corpus          TEXT NOT NULL,           -- 'ocre'
  title           TEXT,
  ric_volume      TEXT,
  ric_number      TEXT,
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
  role      TEXT NOT NULL,                 -- 'authority', 'issuer', 'portrait_obverse', 'portrait_reverse'
  PRIMARY KEY (type_id, person_id, role)
);

CREATE TABLE type_organization (
  type_id         TEXT NOT NULL REFERENCES coin_type(id),
  organization_id TEXT NOT NULL REFERENCES organization(id),
  role            TEXT NOT NULL,           -- 'authority', 'issuer'
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

-- Evidence.
CREATE TABLE institution (
  id          TEXT PRIMARY KEY,
  nomisma_uri TEXT UNIQUE,
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
  UNIQUE (specimen_id, side, url)
);

CREATE INDEX idx_type_mint ON coin_type(mint_id);
CREATE INDEX idx_type_denomination_denom ON type_denomination(denomination_id);
CREATE INDEX idx_type_parent ON coin_type(parent_id);
CREATE INDEX idx_type_person_person ON type_person(person_id);
CREATE INDEX idx_type_subject_subject ON type_subject(subject_id);
CREATE INDEX idx_specimen_type_type ON specimen_type(type_id);
CREATE INDEX idx_image_specimen ON image(specimen_id);
