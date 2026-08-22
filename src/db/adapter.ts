/**
 * The unified async DB interface. Routes depend only on this — never on
 * `better-sqlite3` or `pg` directly — so the backend can switch between SQLite
 * (`deployMode=local`) and Postgres (`deployMode=k8s`) without touching callers.
 * @module dsh-server-login/db/adapter
 */

import type {
  CredentialKey,
  CreateSessionInput,
  CreateUserInput,
  Domain,
  PublicUser,
  SessionRow,
  SessionUser,
  User,
  UserRole,
  Workspace,
} from './types.js'

export interface DbAdapter {
  // users
  createUser(input: CreateUserInput): Promise<User>
  findUserByUsername(username: string): Promise<User | undefined>
  findUserBySlug(slug: string): Promise<User | undefined>
  findUserById(id: string): Promise<User | undefined>
  listPublicUsers(): Promise<PublicUser[]>
  countAdmins(): Promise<number>
  setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean>
  /** Assign a Linux uid to a user (used by the legacy backfill). */
  setUserUid(userId: string, uid: number): Promise<void>
  /** Ids of users whose uid column is still null (legacy rows awaiting backfill). */
  listUsersWithoutUid(): Promise<string[]>
  // sessions
  createSession(input: CreateSessionInput): Promise<void>
  findSession(tokenHash: string): Promise<SessionRow | undefined>
  deleteSession(tokenHash: string): Promise<void>
  deleteUserSessions(userId: string): Promise<void>
  findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined>
  // audit
  audit(actor: string | null, action: string, detail?: string | null): Promise<void>
  // workspaces / plugins
  findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined>
  getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace>
  setFolderPlugins(workspaceId: string, selections: ReadonlyArray<{ id: string; enabled: boolean }>): Promise<void>
  getEnabledPluginIds(workspaceId: string): Promise<string[]>
  // domains
  findDomainByUser(userId: string): Promise<Domain | undefined>
  findDomainById(id: string): Promise<Domain | undefined>
  listDomains(): Promise<Domain[]>
  upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain>
  setDomainVerified(id: string, verified: boolean): Promise<boolean>
  // credential vault
  listCredentialKeys(userId: string): Promise<CredentialKey[]>
  getEnabledCredentialKeyRef(userId: string): Promise<string | null>
  setCredentialKey(userId: string, name: string, encryptedRef: string): Promise<CredentialKey>
  selectCredentialKey(userId: string, id: string): Promise<boolean>
  deleteCredentialKey(userId: string, id: string): Promise<boolean>
  // lifecycle
  close(): Promise<void>
}
