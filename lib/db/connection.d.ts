/**
 * SQLite connection lifecycle: open, WAL, foreign keys, migration.
 * @module dsh-server-login/db/connection
 */
import Database from 'better-sqlite3';
/** The better-sqlite3 instance type. */
export type Database = Database.Database;
/**
 * Open (creating parent directories as needed), enable WAL + foreign keys,
 * then run migrations.
 * @param path - database file path, or `:memory:`.
 */
export declare function openDatabase(path: string): Database;
