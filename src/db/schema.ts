/**
 * Schema migrations. v1 creates the full data model, including tables reserved
 * for later phases (`domains`, `credential_vault`) so the schema is stable from
 * day one.
 * @module dsh-server-login/db/schema
 */

import type { Database } from './connection.js'

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   INTEGER NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   INTEGER,
  last_exit    INTEGER,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key_name)
);
`

/** v2: named per-user credential keys with an enabled flag. */
const V2_SCHEMA = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: V1_SCHEMA },
  { version: 2, name: 'credential vault enabled flag', sql: V2_SCHEMA },
]

/** Apply any unapplied migrations inside a single transaction. */
export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  const applied = new Set(rows.map((row) => row.version))

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    }
  })
  apply()
}
