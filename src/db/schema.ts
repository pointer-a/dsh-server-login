/**
 * Schema migrations, dual-dialect. Each migration carries SQLite and Postgres
 * DDL; the active adapter runs only its own dialect. `schema_migrations` is
 * shared (same table shape), so a SQLite↔Postgres dump/restore round-trips the
 * applied-version marker too.
 *
 * Dialect notes (kept out of the route layer):
 * - timestamps are epoch **milliseconds** (Date.now()), which exceeds 32-bit
 *   `INTEGER`; SQLite `INTEGER` is 64-bit, Postgres uses `BIGINT`.
 * - `enabled`/`verified` are `INTEGER 0/1` in *both* dialects so the row mappers
 *   stay byte-identical across backends (no boolean/0/1 branch).
 * - `audit_log.id` uses SQLite `AUTOINCREMENT` vs Postgres `IDENTITY`.
 * @module dsh-server-login/db/schema
 */

import type { Database } from './connection.js'
import type { Pool } from 'pg'

const SQLITE_V1 = `
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

const SQLITE_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

const PG_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   BIGINT NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   BIGINT NOT NULL,
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
  started_at   BIGINT,
  last_exit    BIGINT,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts           BIGINT NOT NULL,
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
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const PG_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

// v3: per-user Linux uid (non-colliding for new users via an identity column).
// SQLite reuses its implicit `rowid` for the incrementing integer, so only the
// `uid` column is added here; Postgres adds an explicit identity `row_id`.
const SQLITE_V3 = `
ALTER TABLE users ADD COLUMN uid INTEGER;
`

const PG_V3 = `
ALTER TABLE users ADD COLUMN row_id BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE users ADD COLUMN uid BIGINT;
`

interface Migration {
  version: number
  name: string
  sqlite: string
  pg: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sqlite: SQLITE_V1, pg: PG_V1 },
  { version: 2, name: 'credential vault enabled flag', sqlite: SQLITE_V2, pg: PG_V2 },
  { version: 3, name: 'per-user uid', sqlite: SQLITE_V3, pg: PG_V3 },
]

/** Apply unapplied SQLite migrations inside a single transaction. */
export function runSqliteMigrations(db: Database): void {
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
      db.exec(migration.sqlite)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    }
  })
  apply()
}

/** Apply unapplied Postgres migrations inside a single transaction. */
export async function runPgMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `)
    const { rows } = await client.query('SELECT version FROM schema_migrations')
    const applied = new Set(rows.map((row) => row.version as number))
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      await client.query(migration.pg)
      await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        Date.now(),
      ])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
