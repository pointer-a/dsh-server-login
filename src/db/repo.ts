/**
 * User / session / audit data access over the SQLite connection.
 *
 * All access is parameterized (prepared statements). Functions take the
 * connection explicitly so they stay free of Fastify/app state and testable.
 * @module dsh-server-login/db/repo
 */

import { randomUUID } from 'node:crypto'
import type { Database } from './connection.js'
import { prepare } from './prepared.js'

export type UserRole = 'admin' | 'pending' | 'active' | 'disabled'

/** A full user row, including secrets (never serialized to clients). */
export interface User {
  id: string
  username: string
  pass_hash: string
  role: UserRole
  home_dir: string
  api_key_ref: string | null
  created_at: number
  approved_by: string | null
}

/** The user shape safe to return over the wire. */
export interface PublicUser {
  id: string
  username: string
  role: UserRole
  createdAt: number
}

/** A persisted login session (token stored only as its hash). */
export interface SessionRow {
  token_hash: string
  user_id: string
  created_at: number
  expires_at: number
  ip: string | null
  user_agent: string | null
}

const USER_COLS = 'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by'

function toUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    username: row.username as string,
    pass_hash: row.pass_hash as string,
    role: row.role as UserRole,
    home_dir: row.home_dir as string,
    api_key_ref: (row.api_key_ref as string | null) ?? null,
    created_at: row.created_at as number,
    approved_by: (row.approved_by as string | null) ?? null,
  }
}

function toSession(row: Record<string, unknown>): SessionRow {
  return {
    token_hash: row.token_hash as string,
    user_id: row.user_id as string,
    created_at: row.created_at as number,
    expires_at: row.expires_at as number,
    ip: (row.ip as string | null) ?? null,
    user_agent: (row.user_agent as string | null) ?? null,
  }
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.created_at }
}

export interface CreateUserInput {
  id: string
  username: string
  passHash: string
  role: UserRole
  homeDir: string
}

export function createUser(db: Database, input: CreateUserInput): User {
  const createdAt = Date.now()
  prepare(db,
    'INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.id, input.username, input.passHash, input.role, input.homeDir, createdAt)
  return {
    id: input.id,
    username: input.username,
    pass_hash: input.passHash,
    role: input.role,
    home_dir: input.homeDir,
    api_key_ref: null,
    created_at: createdAt,
    approved_by: null,
  }
}

export function findUserByUsername(db: Database, username: string): User | undefined {
  const row = prepare(db,`SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

/** Case-insensitive username lookup (for subdomain routing). */
export function findUserBySlug(db: Database, slug: string): User | undefined {
  const row = prepare(db,`SELECT ${USER_COLS} FROM users WHERE LOWER(username) = ?`).get(slug.toLowerCase())
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function findUserById(db: Database, id: string): User | undefined {
  const row = prepare(db,`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function listPublicUsers(db: Database): PublicUser[] {
  const rows = prepare(db,`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toPublicUser(toUser(row)))
}

export function countAdmins(db: Database): number {
  const row = prepare(db,`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
  return row.n
}

export function setUserRole(db: Database, id: string, role: UserRole, approvedBy?: string): boolean {
  const info =
    approvedBy === undefined
      ? prepare(db,'UPDATE users SET role = ? WHERE id = ?').run(role, id)
      : prepare(db,'UPDATE users SET role = ?, approved_by = ? WHERE id = ?').run(role, approvedBy, id)
  return info.changes > 0
}

export interface CreateSessionInput {
  tokenHash: string
  userId: string
  expiresAt: number
  ip?: string
  userAgent?: string
}

export function createSession(db: Database, input: CreateSessionInput): void {
  prepare(db,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null)
}

export function findSession(db: Database, tokenHash: string): SessionRow | undefined {
  const row = prepare(db, 'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = ?')
    .get(tokenHash)
  return row ? toSession(row as Record<string, unknown>) : undefined
}

export function deleteSession(db: Database, tokenHash: string): void {
  prepare(db,'DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

export function deleteUserSessions(db: Database, userId: string): void {
  prepare(db,'DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** Append an audit entry. `actor` is a user id or `'system'`. */
export function audit(db: Database, actor: string | null, action: string, detail?: string | null): void {
  prepare(db,'INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    Date.now(),
    actor,
    action,
    detail ?? null,
  )
}

/** A per-user project folder (workspace) row. */
export interface Workspace {
  id: string
  userId: string
  name: string
  relPath: string
  createdAt: number
}

function toWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    relPath: row.rel_path as string,
    createdAt: row.created_at as number,
  }
}

export function findWorkspaceByPath(db: Database, userId: string, relPath: string): Workspace | undefined {
  const row = prepare(db, 'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = ? AND rel_path = ?')
    .get(userId, relPath)
  return row ? toWorkspace(row as Record<string, unknown>) : undefined
}

/** Upsert a workspace row by (user, relPath); create with a derived name. */
export function getOrCreateWorkspace(db: Database, userId: string, relPath: string): Workspace {
  const existing = findWorkspaceByPath(db, userId, relPath)
  if (existing !== undefined) return existing
  const id = randomUUID()
  const segments = relPath.split('/').filter(Boolean)
  const name = segments.at(-1) ?? 'root'
  prepare(db,'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    userId,
    name,
    relPath,
    Date.now(),
  )
  return { id, userId, name, relPath, createdAt: Date.now() }
}

/** Replace a workspace's plugin selection (insert/delete in one transaction). */
export function setFolderPlugins(
  db: Database,
  workspaceId: string,
  selections: ReadonlyArray<{ id: string; enabled: boolean }>,
): void {
  const tx = db.transaction(() => {
    prepare(db,'DELETE FROM folder_plugins WHERE workspace_id = ?').run(workspaceId)
    const insert = prepare(db,
      'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const selection of selections) {
      insert.run(workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now())
    }
  })
  tx()
}

/** Enabled plugin ids for a workspace. */
export function getEnabledPluginIds(db: Database, workspaceId: string): string[] {
  const rows = prepare(db, 'SELECT plugin_id FROM folder_plugins WHERE workspace_id = ? AND enabled = 1')
    .all(workspaceId) as Array<{ plugin_id: string }>
  return rows.map((row) => row.plugin_id)
}

/** A custom-domain row. */
export interface Domain {
  id: string
  userId: string
  domain: string
  verified: number
  nginxConfig: string | null
  updatedAt: number
}

function toDomain(row: Record<string, unknown>): Domain {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    domain: row.domain as string,
    verified: row.verified as number,
    nginxConfig: (row.nginx_config as string | null) ?? null,
    updatedAt: row.updated_at as number,
  }
}

const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at'

export function findDomainByUser(db: Database, userId: string): Domain | undefined {
  const row = prepare(db,`SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = ?`).get(userId)
  return row ? toDomain(row as Record<string, unknown>) : undefined
}

export function findDomainById(db: Database, id: string): Domain | undefined {
  const row = prepare(db,`SELECT ${DOMAIN_COLS} FROM domains WHERE id = ?`).get(id)
  return row ? toDomain(row as Record<string, unknown>) : undefined
}

export function listDomains(db: Database): Domain[] {
  const rows = prepare(db,`SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toDomain(row))
}

/** Upsert a user's custom domain (resetting `verified` to 0). */
export function upsertDomain(db: Database, userId: string, domain: string, nginxConfig: string): Domain {
  prepare(db,`
    INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      domain = excluded.domain,
      verified = 0,
      nginx_config = excluded.nginx_config,
      updated_at = excluded.updated_at
  `).run(randomUUID(), userId, domain, nginxConfig, Date.now())
  return findDomainByUser(db, userId)!
}

/** Store a user's encrypted API-key ref. Returns whether a row was updated. */
export function setUserApiKeyRef(db: Database, userId: string, encryptedRef: string | null): boolean {
  const info = prepare(db, 'UPDATE users SET api_key_ref = ? WHERE id = ?').run(encryptedRef, userId)
  return info.changes > 0
}

/** Read a user's encrypted API-key ref (decrypt with the deployment secret). */
export function getUserApiKeyRef(db: Database, userId: string): string | null {
  const row = prepare(db, 'SELECT api_key_ref FROM users WHERE id = ?').get(userId) as { api_key_ref: string | null } | undefined
  return row?.api_key_ref ?? null
}

/** Set the verified flag on a domain. */
export function setDomainVerified(db: Database, id: string, verified: boolean): boolean {
  const info = prepare(db, 'UPDATE domains SET verified = ?, updated_at = ? WHERE id = ?')
    .run(verified ? 1 : 0, Date.now(), id)
  return info.changes > 0
}

/** A session joined with its user, for the authn hot path (one query). */
export interface SessionUser {
  expiresAt: number
  user: User
}

/** Look up a session and its user in a single join. */
export function findSessionWithUser(db: Database, tokenHash: string): SessionUser | undefined {
  const row = prepare(
    db,
    `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by,
            s.expires_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ?`,
  ).get(tokenHash) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return { expiresAt: row.expires_at as number, user: toUser(row) }
}
