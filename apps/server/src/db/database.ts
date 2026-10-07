import { DatabaseSync } from 'node:sqlite';

/** Forward-only migrations; index + 1 is the schema version (PRAGMA user_version). */
const migrations: string[] = [
  `
  CREATE TABLE recordings (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    media_type        TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL,
    stored_name       TEXT NOT NULL,
    duration_seconds  REAL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE jobs (
    id            TEXT PRIMARY KEY,
    recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    status        TEXT NOT NULL,
    progress      REAL,
    error_code    TEXT,
    error_message TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
  );
  CREATE INDEX jobs_recording ON jobs(recording_id, created_at);
  CREATE INDEX jobs_status ON jobs(status, created_at);

  CREATE TABLE transcripts (
    recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    language      TEXT,
    text          TEXT NOT NULL,
    model         TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE segments (
    recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds   REAL NOT NULL,
    text          TEXT NOT NULL,
    PRIMARY KEY (recording_id, idx)
  );
  `,
  `
  CREATE TABLE summaries (
    recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    summary       TEXT NOT NULL,
    action_items  TEXT NOT NULL,
    model         TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE ai_settings (
    kind        TEXT PRIMARY KEY,
    mode        TEXT NOT NULL,
    provider    TEXT,
    base_url    TEXT NOT NULL,
    model       TEXT NOT NULL,
    api_key     TEXT,
    updated_at  TEXT NOT NULL
  );

  -- Searchable text per recording. *_lc columns are lower-cased in JavaScript,
  -- because SQLite's lower() and LIKE only fold ASCII (Cyrillic would not match).
  CREATE TABLE search_docs (
    recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    title_lc      TEXT NOT NULL,
    body_lc       TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE recordings ADD COLUMN source_url TEXT;
  ALTER TABLE recordings ADD COLUMN title_from_source INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Searchable text now folds ё into е; SearchIndex rebuilds every entry on start.
  DELETE FROM search_docs;
  DROP TABLE IF EXISTS search_fts;
  `,
];

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  for (let version = current; version < migrations.length; version++) {
    transaction(db, () => {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
