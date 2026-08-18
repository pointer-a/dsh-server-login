/**
 * User / session / audit data access over the SQLite connection.
 *
 * All access is parameterized (prepared statements). Functions take the
 * connection explicitly so they stay free of Fastify/app state and testable.
 * @module dsh-server-login/db/repo
 */
const USER_COLS = 'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by';
function toUser(row) {
    return {
        id: row.id,
        username: row.username,
        pass_hash: row.pass_hash,
        role: row.role,
        home_dir: row.home_dir,
        api_key_ref: row.api_key_ref ?? null,
        created_at: row.created_at,
        approved_by: row.approved_by ?? null,
    };
}
function toSession(row) {
    return {
        token_hash: row.token_hash,
        user_id: row.user_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        ip: row.ip ?? null,
        user_agent: row.user_agent ?? null,
    };
}
export function toPublicUser(user) {
    return { id: user.id, username: user.username, role: user.role, createdAt: user.created_at };
}
export function createUser(db, input) {
    const createdAt = Date.now();
    db.prepare('INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(input.id, input.username, input.passHash, input.role, input.homeDir, createdAt);
    return {
        id: input.id,
        username: input.username,
        pass_hash: input.passHash,
        role: input.role,
        home_dir: input.homeDir,
        api_key_ref: null,
        created_at: createdAt,
        approved_by: null,
    };
}
export function findUserByUsername(db, username) {
    const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username);
    return row ? toUser(row) : undefined;
}
export function findUserById(db, id) {
    const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
    return row ? toUser(row) : undefined;
}
export function listPublicUsers(db) {
    const rows = db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all();
    return rows.map((row) => toPublicUser(toUser(row)));
}
export function countAdmins(db) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get();
    return row.n;
}
export function setUserRole(db, id, role, approvedBy) {
    const info = approvedBy === undefined
        ? db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
        : db.prepare('UPDATE users SET role = ?, approved_by = ? WHERE id = ?').run(role, approvedBy, id);
    return info.changes > 0;
}
export function createSession(db, input) {
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null);
}
export function findSession(db, tokenHash) {
    const row = db
        .prepare('SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = ?')
        .get(tokenHash);
    return row ? toSession(row) : undefined;
}
export function deleteSession(db, tokenHash) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}
export function deleteUserSessions(db, userId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
/** Append an audit entry. `actor` is a user id or `'system'`. */
export function audit(db, actor, action, detail) {
    db.prepare('INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(Date.now(), actor, action, detail ?? null);
}
//# sourceMappingURL=repo.js.map