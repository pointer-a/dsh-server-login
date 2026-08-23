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

/** Which half of a user's DSH pair a `dsh_instances` row describes. */
export type DshInstanceRole = 'main' | 'watchdog'

/** Lifecycle state of a `dsh_instances` row (mirrors the column's CHECK). */
export type DshInstanceStatus = 'starting' | 'running' | 'crashed' | 'repairing' | 'stopped'

/**
 * A persisted DSH instance — the **desired** state the k8s controller reconciles
 * the cluster against (docs/k8s.md §5.7). `folder` and `patch` are what a
 * relaunch needs; `pid`/`port` are local-mode only and stay null under k8s.
 */
export interface DshInstance {
  id: string
  userId: string
  workspaceId: string | null
  role: DshInstanceRole
  pid: number | null
  port: number | null
  status: DshInstanceStatus
  startedAt: number | null
  lastExit: number | null
  exitCode: number | null
  lastError: string | null
  folder: string | null
  /** Rendered Cordis patch content (not a path — the control plane holds no user volume). */
  patch: string | null
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

/** Upsert payload for `dsh_instances`; `id` is the deterministic resource name. */
export interface UpsertDshInstanceInput {
  id: string
  userId: string
  role: DshInstanceRole
  status: DshInstanceStatus
  folder?: string
  patch?: string
  workspaceId?: string
  pid?: number
  port?: number
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

export function toDshInstance(row: Record<string, unknown>): DshInstance {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    role: row.role as DshInstanceRole,
    pid: (row.pid as number | null) ?? null,
    port: (row.port as number | null) ?? null,
    status: row.status as DshInstanceStatus,
    startedAt: (row.started_at as number | null) ?? null,
    lastExit: (row.last_exit as number | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    folder: (row.folder as string | null) ?? null,
    patch: (row.patch as string | null) ?? null,
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
