/**
 * User / session / audit data access over the SQLite connection.
 *
 * All access is parameterized (prepared statements). Functions take the
 * connection explicitly so they stay free of Fastify/app state and testable.
 * @module dsh-server-login/db/repo
 */
import type { Database } from './connection.js';
export type UserRole = 'admin' | 'pending' | 'active' | 'disabled';
/** A full user row, including secrets (never serialized to clients). */
export interface User {
    id: string;
    username: string;
    pass_hash: string;
    role: UserRole;
    home_dir: string;
    api_key_ref: string | null;
    created_at: number;
    approved_by: string | null;
}
/** The user shape safe to return over the wire. */
export interface PublicUser {
    id: string;
    username: string;
    role: UserRole;
    createdAt: number;
}
/** A persisted login session (token stored only as its hash). */
export interface SessionRow {
    token_hash: string;
    user_id: string;
    created_at: number;
    expires_at: number;
    ip: string | null;
    user_agent: string | null;
}
export declare function toPublicUser(user: User): PublicUser;
export interface CreateUserInput {
    id: string;
    username: string;
    passHash: string;
    role: UserRole;
    homeDir: string;
}
export declare function createUser(db: Database, input: CreateUserInput): User;
export declare function findUserByUsername(db: Database, username: string): User | undefined;
/** Case-insensitive username lookup (for subdomain routing). */
export declare function findUserBySlug(db: Database, slug: string): User | undefined;
export declare function findUserById(db: Database, id: string): User | undefined;
export declare function listPublicUsers(db: Database): PublicUser[];
export declare function countAdmins(db: Database): number;
export declare function setUserRole(db: Database, id: string, role: UserRole, approvedBy?: string): boolean;
export interface CreateSessionInput {
    tokenHash: string;
    userId: string;
    expiresAt: number;
    ip?: string;
    userAgent?: string;
}
export declare function createSession(db: Database, input: CreateSessionInput): void;
export declare function findSession(db: Database, tokenHash: string): SessionRow | undefined;
export declare function deleteSession(db: Database, tokenHash: string): void;
export declare function deleteUserSessions(db: Database, userId: string): void;
/** Append an audit entry. `actor` is a user id or `'system'`. */
export declare function audit(db: Database, actor: string | null, action: string, detail?: string | null): void;
/** A per-user project folder (workspace) row. */
export interface Workspace {
    id: string;
    userId: string;
    name: string;
    relPath: string;
    createdAt: number;
}
export declare function findWorkspaceByPath(db: Database, userId: string, relPath: string): Workspace | undefined;
/** Upsert a workspace row by (user, relPath); create with a derived name. */
export declare function getOrCreateWorkspace(db: Database, userId: string, relPath: string): Workspace;
/** Replace a workspace's plugin selection (insert/delete in one transaction). */
export declare function setFolderPlugins(db: Database, workspaceId: string, selections: ReadonlyArray<{
    id: string;
    enabled: boolean;
}>): void;
/** Enabled plugin ids for a workspace. */
export declare function getEnabledPluginIds(db: Database, workspaceId: string): string[];
/** A custom-domain row. */
export interface Domain {
    id: string;
    userId: string;
    domain: string;
    verified: number;
    nginxConfig: string | null;
    updatedAt: number;
}
export declare function findDomainByUser(db: Database, userId: string): Domain | undefined;
export declare function findDomainById(db: Database, id: string): Domain | undefined;
export declare function listDomains(db: Database): Domain[];
/** Upsert a user's custom domain (resetting `verified` to 0). */
export declare function upsertDomain(db: Database, userId: string, domain: string, nginxConfig: string): Domain;
/** Store a user's encrypted API-key ref. Returns whether a row was updated. */
export declare function setUserApiKeyRef(db: Database, userId: string, encryptedRef: string | null): boolean;
/** Read a user's encrypted API-key ref (decrypt with the deployment secret). */
export declare function getUserApiKeyRef(db: Database, userId: string): string | null;
/** Set the verified flag on a domain. */
export declare function setDomainVerified(db: Database, id: string, verified: boolean): boolean;
/** A session joined with its user, for the authn hot path (one query). */
export interface SessionUser {
    expiresAt: number;
    user: User;
}
/** Look up a session and its user in a single join. */
export declare function findSessionWithUser(db: Database, tokenHash: string): SessionUser | undefined;
