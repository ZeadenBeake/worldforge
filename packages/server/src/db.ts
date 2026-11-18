import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

/**
 * Migrations are append-only and run in order; `PRAGMA user_version` records
 * how many have been applied. Never edit an applied migration: add a new one.
 */
const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE worlds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',   -- JSON: { ordinals?, breeding? }
    rev INTEGER NOT NULL DEFAULT 0,        -- bumped on every write; invalidates registry caches
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,                      -- what other bodies reference; unique per world+kind
    name TEXT NOT NULL,
    body TEXT NOT NULL,                     -- JSON, never contains the id/key
    notes TEXT,
    origin TEXT,                            -- JSON: { pack, version, key } when imported from a pack
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (world_id, kind, key)
  );
  CREATE INDEX entities_world_kind ON entities (world_id, kind);

  -- What each entity's body points at, by kind+key (the target may not exist yet).
  CREATE TABLE refs (
    world_id TEXT NOT NULL,
    from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_kind TEXT NOT NULL,
    to_key TEXT NOT NULL
  );
  CREATE INDEX refs_to ON refs (world_id, to_kind, to_key);
  CREATE INDEX refs_from ON refs (from_id);

  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '{}',        -- JSON: { feeling?, since? }
    created_at TEXT NOT NULL
  );
  CREATE INDEX links_from ON links (from_id);
  CREATE INDEX links_to ON links (to_id);

  -- Every mutation, with full before/after bodies: powers undo, diffs for LLM
  -- proposals, and (later) a timeline.
  CREATE TABLE edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL,
    batch TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,                       -- create | update | delete
    before TEXT,
    after TEXT,
    actor TEXT NOT NULL DEFAULT 'user',
    note TEXT,
    undone_by INTEGER,
    at TEXT NOT NULL
  );
  CREATE INDEX edits_entity ON edits (entity_id, id);
  CREATE INDEX edits_world ON edits (world_id, id);

  CREATE TABLE packs (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    manifest TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    PRIMARY KEY (world_id, pack_id)
  );

  CREATE VIRTUAL TABLE entities_fts USING fts5(entity_id UNINDEXED, world_id UNINDEXED, text, tokenize = 'porter unicode61');
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
