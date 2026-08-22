/**
 * Domain types shared by both DB backends (SQLite and Postgres). Kept free of
 * any driver so the `DbAdapter` implementations and the route layer depend only
 * on these shapes, never on `better-sqlite3` or `pg`.
 * @module dsh-server-login/db/types
 */

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
  /** Assigned Linux uid; null until backfilled/assigned (legacy rows). */
  uid: number | null
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

/** A session joined with its user, for the authn hot path (one query). */
export interface SessionUser {
  expiresAt: number
  user: User
}

/** A per-user project folder (workspace) row. */
export interface Workspace {
  id: string
  userId: string
  name: string
  relPath: string
  createdAt: number
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

/** A named per-user credential key (secret never exposed). */
export interface CredentialKey {
  id: string
  name: string
  enabled: boolean
  updatedAt: number
}

export interface CreateUserInput {
  id: string
  username: string
  passHash: string
  role: UserRole
  homeDir: string
}

export interface CreateSessionInput {
  tokenHash: string
  userId: string
  expiresAt: number
  ip?: string
  userAgent?: string
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.created_at }
}

// Row mappers. Shared by both adapters — they read the same column names, so the
// only dialect difference (SQLite 64-bit INTEGER vs Postgres BIGINT→number) is
// resolved by the Postgres int8 parser before these run.

export function toUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    username: row.username as string,
    pass_hash: row.pass_hash as string,
    role: row.role as UserRole,
    home_dir: row.home_dir as string,
    api_key_ref: (row.api_key_ref as string | null) ?? null,
    created_at: row.created_at as number,
    approved_by: (row.approved_by as string | null) ?? null,
    uid: (row.uid as number | null) ?? null,
  }
}

export function toSession(row: Record<string, unknown>): SessionRow {
  return {
    token_hash: row.token_hash as string,
    user_id: row.user_id as string,
    created_at: row.created_at as number,
    expires_at: row.expires_at as number,
    ip: (row.ip as string | null) ?? null,
    user_agent: (row.user_agent as string | null) ?? null,
  }
}

export function toWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    relPath: row.rel_path as string,
    createdAt: row.created_at as number,
  }
}

export function toDomain(row: Record<string, unknown>): Domain {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    domain: row.domain as string,
    verified: row.verified as number,
    nginxConfig: (row.nginx_config as string | null) ?? null,
    updatedAt: row.updated_at as number,
  }
}
