/**
 * Prepared-statement cache. better-sqlite3 does not cache `db.prepare`, so
 * re-preparing the same SQL on every call re-parses it. This memoizes prepared
 * statements per connection (WeakMap), which matters for hot paths such as
 * authentication and the reverse proxy.
 * @module dsh-server-login/db/prepared
 */
import type Database from 'better-sqlite3';
import type { Database as Db } from './connection.js';
type Statement = Database.Statement<unknown[], unknown>;
/** Prepare (and cache) a statement for a connection. */
export declare function prepare(db: Db, sql: string): Statement;
export {};
