/**
 * Schema migrations. v1 creates the full data model, including tables reserved
 * for later phases (`domains`, `credential_vault`) so the schema is stable from
 * day one.
 * @module dsh-server-login/db/schema
 */
import type { Database } from './connection.js';
/** Apply any unapplied migrations inside a single transaction. */
export declare function runMigrations(db: Database): void;
