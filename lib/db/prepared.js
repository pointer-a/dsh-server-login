/**
 * Prepared-statement cache. better-sqlite3 does not cache `db.prepare`, so
 * re-preparing the same SQL on every call re-parses it. This memoizes prepared
 * statements per connection (WeakMap), which matters for hot paths such as
 * authentication and the reverse proxy.
 * @module dsh-server-login/db/prepared
 */
const caches = new WeakMap();
/** Prepare (and cache) a statement for a connection. */
export function prepare(db, sql) {
    let cache = caches.get(db);
    if (cache === undefined) {
        cache = new Map();
        caches.set(db, cache);
    }
    let statement = cache.get(sql);
    if (statement === undefined) {
        statement = db.prepare(sql);
        cache.set(sql, statement);
    }
    return statement;
}
//# sourceMappingURL=prepared.js.map