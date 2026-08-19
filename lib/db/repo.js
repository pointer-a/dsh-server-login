/**
 * User / session / audit data access over the SQLite connection.
 *
 * All access is parameterized (prepared statements). Functions take the
 * connection explicitly so they stay free of Fastify/app state and testable.
 * @module dsh-server-login/db/repo
 */
import { randomUUID } from 'node:crypto';
import { prepare } from './prepared.js';
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
    prepare(db, 'INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(input.id, input.username, input.passHash, input.role, input.homeDir, createdAt);
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
    const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username);
    return row ? toUser(row) : undefined;
}
/** Case-insensitive username lookup (for subdomain routing). */
export function findUserBySlug(db, slug) {
    const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE LOWER(username) = ?`).get(slug.toLowerCase());
    return row ? toUser(row) : undefined;
}
export function findUserById(db, id) {
    const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
    return row ? toUser(row) : undefined;
}
export function listPublicUsers(db) {
    const rows = prepare(db, `SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all();
    return rows.map((row) => toPublicUser(toUser(row)));
}
export function countAdmins(db) {
    const row = prepare(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get();
    return row.n;
}
export function setUserRole(db, id, role, approvedBy) {
    const info = approvedBy === undefined
        ? prepare(db, 'UPDATE users SET role = ? WHERE id = ?').run(role, id)
        : prepare(db, 'UPDATE users SET role = ?, approved_by = ? WHERE id = ?').run(role, approvedBy, id);
    return info.changes > 0;
}
export function createSession(db, input) {
    prepare(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null);
}
export function findSession(db, tokenHash) {
    const row = prepare(db, 'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = ?')
        .get(tokenHash);
    return row ? toSession(row) : undefined;
}
export function deleteSession(db, tokenHash) {
    prepare(db, 'DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}
export function deleteUserSessions(db, userId) {
    prepare(db, 'DELETE FROM sessions WHERE user_id = ?').run(userId);
}
/** Append an audit entry. `actor` is a user id or `'system'`. */
export function audit(db, actor, action, detail) {
    prepare(db, 'INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(Date.now(), actor, action, detail ?? null);
}
function toWorkspace(row) {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        relPath: row.rel_path,
        createdAt: row.created_at,
    };
}
export function findWorkspaceByPath(db, userId, relPath) {
    const row = prepare(db, 'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = ? AND rel_path = ?')
        .get(userId, relPath);
    return row ? toWorkspace(row) : undefined;
}
/** Upsert a workspace row by (user, relPath); create with a derived name. */
export function getOrCreateWorkspace(db, userId, relPath) {
    const existing = findWorkspaceByPath(db, userId, relPath);
    if (existing !== undefined)
        return existing;
    const id = randomUUID();
    const segments = relPath.split('/').filter(Boolean);
    const name = segments.at(-1) ?? 'root';
    prepare(db, 'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, name, relPath, Date.now());
    return { id, userId, name, relPath, createdAt: Date.now() };
}
/** Replace a workspace's plugin selection (insert/delete in one transaction). */
export function setFolderPlugins(db, workspaceId, selections) {
    const tx = db.transaction(() => {
        prepare(db, 'DELETE FROM folder_plugins WHERE workspace_id = ?').run(workspaceId);
        const insert = prepare(db, 'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES (?, ?, ?, ?)');
        for (const selection of selections) {
            insert.run(workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now());
        }
    });
    tx();
}
/** Enabled plugin ids for a workspace. */
export function getEnabledPluginIds(db, workspaceId) {
    const rows = prepare(db, 'SELECT plugin_id FROM folder_plugins WHERE workspace_id = ? AND enabled = 1')
        .all(workspaceId);
    return rows.map((row) => row.plugin_id);
}
function toDomain(row) {
    return {
        id: row.id,
        userId: row.user_id,
        domain: row.domain,
        verified: row.verified,
        nginxConfig: row.nginx_config ?? null,
        updatedAt: row.updated_at,
    };
}
const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at';
export function findDomainByUser(db, userId) {
    const row = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = ?`).get(userId);
    return row ? toDomain(row) : undefined;
}
export function findDomainById(db, id) {
    const row = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains WHERE id = ?`).get(id);
    return row ? toDomain(row) : undefined;
}
export function listDomains(db) {
    const rows = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`).all();
    return rows.map((row) => toDomain(row));
}
/** Upsert a user's custom domain (resetting `verified` to 0). */
export function upsertDomain(db, userId, domain, nginxConfig) {
    prepare(db, `
    INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      domain = excluded.domain,
      verified = 0,
      nginx_config = excluded.nginx_config,
      updated_at = excluded.updated_at
  `).run(randomUUID(), userId, domain, nginxConfig, Date.now());
    return findDomainByUser(db, userId);
}
/** List a user's named credential keys (metadata only). */
export function listCredentialKeys(db, userId) {
    const rows = prepare(db, 'SELECT id, key_name, enabled, updated_at FROM credential_vault WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    return rows.map((r) => ({ id: r.id, name: r.key_name, enabled: r.enabled === 1, updatedAt: r.updated_at }));
}
/** The enabled key's encrypted ref for a user (decrypt with the deployment secret). */
export function getEnabledCredentialKeyRef(db, userId) {
    const row = prepare(db, 'SELECT secret_ref FROM credential_vault WHERE user_id = ? AND enabled = 1').get(userId);
    return row?.secret_ref ?? null;
}
/** Upsert a named key, disable the others, and enable this one. */
export function setCredentialKey(db, userId, name, encryptedRef) {
    const id = db.transaction(() => {
        prepare(db, 'UPDATE credential_vault SET enabled = 0 WHERE user_id = ?').run(userId);
        const existing = prepare(db, 'SELECT id FROM credential_vault WHERE user_id = ? AND key_name = ?').get(userId, name);
        if (existing !== undefined) {
            prepare(db, 'UPDATE credential_vault SET secret_ref = ?, enabled = 1, updated_at = ? WHERE id = ?').run(encryptedRef, Date.now(), existing.id);
            return existing.id;
        }
        const id = randomUUID();
        prepare(db, 'INSERT INTO credential_vault (id, user_id, key_name, secret_ref, enabled, updated_at) VALUES (?, ?, ?, ?, 1, ?)').run(id, userId, name, encryptedRef, Date.now());
        return id;
    })();
    return { id, name, enabled: true, updatedAt: Date.now() };
}
/** Enable one of a user's named keys (disabling the others). */
export function selectCredentialKey(db, userId, id) {
    const ok = db.transaction(() => {
        prepare(db, 'UPDATE credential_vault SET enabled = 0 WHERE user_id = ?').run(userId);
        const info = prepare(db, 'UPDATE credential_vault SET enabled = 1 WHERE id = ? AND user_id = ?').run(id, userId);
        return info.changes > 0;
    })();
    return ok;
}
/** Delete a named key (by id, scoped to the user). */
export function deleteCredentialKey(db, userId, id) {
    const info = prepare(db, 'DELETE FROM credential_vault WHERE id = ? AND user_id = ?').run(id, userId);
    return info.changes > 0;
}
/** Set the verified flag on a domain. */
export function setDomainVerified(db, id, verified) {
    const info = prepare(db, 'UPDATE domains SET verified = ?, updated_at = ? WHERE id = ?')
        .run(verified ? 1 : 0, Date.now(), id);
    return info.changes > 0;
}
/** Look up a session and its user in a single join. */
export function findSessionWithUser(db, tokenHash) {
    const row = prepare(db, `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by,
            s.expires_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ?`).get(tokenHash);
    if (row === undefined)
        return undefined;
    return { expiresAt: row.expires_at, user: toUser(row) };
}
//# sourceMappingURL=repo.js.map