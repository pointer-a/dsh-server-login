/**
 * SQLite connection lifecycle: open, WAL, foreign keys, migration.
 * @module dsh-server-login/db/connection
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './schema.js';
/**
 * Open (creating parent directories as needed), enable WAL + foreign keys,
 * then run migrations.
 * @param path - database file path, or `:memory:`.
 */
export function openDatabase(path) {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}
//# sourceMappingURL=connection.js.map