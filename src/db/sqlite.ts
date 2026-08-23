/**
 * SQLite backend for {@link DbAdapter}. Wraps the synchronous better-sqlite3
 * repo in async methods and maps constraint errors onto the shared hierarchy.
 * Used when `deployMode=local` (no `DSH_SERVER_LOGIN_DB_URL`).
 *
 * NOTE: better-sqlite3 is synchronous; the `async` here only matches the
 * interface — the underlying calls still block the event loop. Fine for the
 * small single-machine local mode this backend targets (see docs/k8s.md §5.1).
 * @module dsh-server-login/db/sqlite
 */

import type { DbAdapter } from './adapter.js'
import { openDatabase, type Database } from './connection.js'
import { mapSqliteError } from './errors.js'
import {
  audit as auditSync,
  countAdmins as countAdminsSync,
  createSession as createSessionSync,
  createUser as createUserSync,
  deleteCredentialKey as deleteCredentialKeySync,
  deleteInstance as deleteInstanceSync,
  deleteSession as deleteSessionSync,
  deleteUserInstances as deleteUserInstancesSync,
  deleteUserSessions as deleteUserSessionsSync,
  findDomainById as findDomainByIdSync,
  findDomainByUser as findDomainByUserSync,
  findInstance as findInstanceSync,
  findSession as findSessionSync,
  findSessionWithUser as findSessionWithUserSync,
  findUserById as findUserByIdSync,
  findUserBySlug as findUserBySlugSync,
  findUserByUsername as findUserByUsernameSync,
  findUserInstance as findUserInstanceSync,
  findWorkspaceByPath as findWorkspaceByPathSync,
  getEnabledCredentialKeyRef as getEnabledCredentialKeyRefSync,
  getEnabledPluginIds as getEnabledPluginIdsSync,
  getOrCreateWorkspace as getOrCreateWorkspaceSync,
  listCredentialKeys as listCredentialKeysSync,
  listDomains as listDomainsSync,
  listInstancesByRole as listInstancesByRoleSync,
  listPublicUsers as listPublicUsersSync,
  listUsersWithoutUid as listUsersWithoutUidSync,
  selectCredentialKey as selectCredentialKeySync,
  setCredentialKey as setCredentialKeySync,
  setDomainVerified as setDomainVerifiedSync,
  setFolderPlugins as setFolderPluginsSync,
  setInstanceStatus as setInstanceStatusSync,
  setUserRole as setUserRoleSync,
  setUserUid as setUserUidSync,
  upsertDomain as upsertDomainSync,
  upsertInstance as upsertInstanceSync,
} from './repo.js'
import type {
  CredentialKey,
  CreateSessionInput,
  CreateUserInput,
  Domain,
  DshInstance,
  DshInstanceRole,
  DshInstanceStatus,
  PublicUser,
  SessionRow,
  SessionUser,
  UpsertDshInstanceInput,
  User,
  UserRole,
  Workspace,
} from './types.js'

export class SqliteAdapter implements DbAdapter {
  private readonly db: Database

  constructor(path: string, private readonly baseUid: number) {
    this.db = openDatabase(path)
  }

  async createUser(input: CreateUserInput): Promise<User> {
    try {
      return createUserSync(this.db, input, this.baseUid)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    return findUserByUsernameSync(this.db, username)
  }

  async findUserBySlug(slug: string): Promise<User | undefined> {
    return findUserBySlugSync(this.db, slug)
  }

  async findUserById(id: string): Promise<User | undefined> {
    return findUserByIdSync(this.db, id)
  }

  async listPublicUsers(): Promise<PublicUser[]> {
    return listPublicUsersSync(this.db)
  }

  async countAdmins(): Promise<number> {
    return countAdminsSync(this.db)
  }

  async setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean> {
    return setUserRoleSync(this.db, id, role, approvedBy)
  }

  async setUserUid(userId: string, uid: number): Promise<void> {
    setUserUidSync(this.db, userId, uid)
  }

  async listUsersWithoutUid(): Promise<string[]> {
    return listUsersWithoutUidSync(this.db)
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    try {
      createSessionSync(this.db, input)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findSession(tokenHash: string): Promise<SessionRow | undefined> {
    return findSessionSync(this.db, tokenHash)
  }

  async deleteSession(tokenHash: string): Promise<void> {
    deleteSessionSync(this.db, tokenHash)
  }

  async deleteUserSessions(userId: string): Promise<void> {
    deleteUserSessionsSync(this.db, userId)
  }

  async findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined> {
    return findSessionWithUserSync(this.db, tokenHash)
  }

  async audit(actor: string | null, action: string, detail?: string | null): Promise<void> {
    auditSync(this.db, actor, action, detail)
  }

  async findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined> {
    return findWorkspaceByPathSync(this.db, userId, relPath)
  }

  async getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace> {
    try {
      return getOrCreateWorkspaceSync(this.db, userId, relPath)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async setFolderPlugins(
    workspaceId: string,
    selections: ReadonlyArray<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    try {
      setFolderPluginsSync(this.db, workspaceId, selections)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async getEnabledPluginIds(workspaceId: string): Promise<string[]> {
    return getEnabledPluginIdsSync(this.db, workspaceId)
  }

  async findDomainByUser(userId: string): Promise<Domain | undefined> {
    return findDomainByUserSync(this.db, userId)
  }

  async findDomainById(id: string): Promise<Domain | undefined> {
    return findDomainByIdSync(this.db, id)
  }

  async listDomains(): Promise<Domain[]> {
    return listDomainsSync(this.db)
  }

  async upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain> {
    try {
      return upsertDomainSync(this.db, userId, domain, nginxConfig)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async setDomainVerified(id: string, verified: boolean): Promise<boolean> {
    return setDomainVerifiedSync(this.db, id, verified)
  }

  async listCredentialKeys(userId: string): Promise<CredentialKey[]> {
    return listCredentialKeysSync(this.db, userId)
  }

  async getEnabledCredentialKeyRef(userId: string): Promise<string | null> {
    return getEnabledCredentialKeyRefSync(this.db, userId)
  }

  async setCredentialKey(userId: string, name: string, encryptedRef: string): Promise<CredentialKey> {
    try {
      return setCredentialKeySync(this.db, userId, name, encryptedRef)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async selectCredentialKey(userId: string, id: string): Promise<boolean> {
    return selectCredentialKeySync(this.db, userId, id)
  }

  async deleteCredentialKey(userId: string, id: string): Promise<boolean> {
    return deleteCredentialKeySync(this.db, userId, id)
  }

  async upsertInstance(input: UpsertDshInstanceInput): Promise<void> {
    try {
      upsertInstanceSync(this.db, input)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findInstance(id: string): Promise<DshInstance | undefined> {
    return findInstanceSync(this.db, id)
  }

  async findUserInstance(userId: string, role: DshInstanceRole): Promise<DshInstance | undefined> {
    return findUserInstanceSync(this.db, userId, role)
  }

  async listInstancesByRole(role: DshInstanceRole): Promise<DshInstance[]> {
    return listInstancesByRoleSync(this.db, role)
  }

  async setInstanceStatus(
    id: string,
    status: DshInstanceStatus,
    outcome?: { exitCode?: number; lastError?: string },
  ): Promise<boolean> {
    return setInstanceStatusSync(this.db, id, status, outcome)
  }

  async deleteInstance(id: string): Promise<boolean> {
    return deleteInstanceSync(this.db, id)
  }

  async deleteUserInstances(userId: string): Promise<void> {
    deleteUserInstancesSync(this.db, userId)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
