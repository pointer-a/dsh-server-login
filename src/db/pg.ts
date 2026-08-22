/**
 * Postgres backend for {@link DbAdapter} via node-postgres (`pg`). Used when
 * `deployMode=k8s` (a `DSH_SERVER_LOGIN_DB_URL` is set). All methods are
 * genuinely async; transactions use {@link withTx}.
 * @module dsh-server-login/db/pg
 */

import { randomUUID } from 'node:crypto'
import { Pool, types, type PoolClient } from 'pg'
import type { DbAdapter } from './adapter.js'
import { mapPgError } from './errors.js'
import { runPgMigrations } from './schema.js'
import {
  toDomain,
  toPublicUser,
  toSession,
  toUser,
  toWorkspace,
  type CredentialKey,
  type CreateSessionInput,
  type CreateUserInput,
  type Domain,
  type PublicUser,
  type SessionRow,
  type SessionUser,
  type User,
  type UserRole,
  type Workspace,
} from './types.js'

// Postgres returns int8 (BIGINT) as a string to avoid JS 53-bit precision loss.
// Our only BIGINT columns are epoch-*milliseconds*, which stay well below 2^53,
// so parse them back to numbers — the shared row mappers then read numbers in
// both backends. This is process-global and idempotent.
types.setTypeParser(20, (value: string) => Number(value))

const USER_COLS = 'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by, uid'
const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at'

/** Run `fn` on a dedicated client inside a BEGIN/COMMIT/ROLLBACK transaction. */
export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export class PgAdapter implements DbAdapter {
  constructor(private readonly pool: Pool, private readonly baseUid: number) {}

  async createUser(input: CreateUserInput): Promise<User> {
    const createdAt = Date.now()
    try {
      return await withTx(this.pool, async (client) => {
        const { rows } = await client.query(
          'INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING row_id',
          [input.id, input.username, input.passHash, input.role, input.homeDir, createdAt],
        )
        const uid = this.baseUid + Number((rows[0] as { row_id: number }).row_id)
        await client.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, input.id])
        return {
          id: input.id,
          username: input.username,
          pass_hash: input.passHash,
          role: input.role,
          home_dir: input.homeDir,
          api_key_ref: null,
          created_at: createdAt,
          approved_by: null,
          uid,
        }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE username = $1`, [username])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserBySlug(slug: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE LOWER(username) = $1`, [
      slug.toLowerCase(),
    ])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserById(id: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async listPublicUsers(): Promise<PublicUser[]> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`)
    return rows.map((row) => toPublicUser(toUser(row as Record<string, unknown>)))
  }

  async countAdmins(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
    return (rows[0] as { n: number }).n
  }

  async setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean> {
    const result =
      approvedBy === undefined
        ? await this.pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id])
        : await this.pool.query('UPDATE users SET role = $1, approved_by = $2 WHERE id = $3', [role, approvedBy, id])
    return (result.rowCount ?? 0) > 0
  }

  async setUserUid(userId: string, uid: number): Promise<void> {
    await this.pool.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, userId])
  }

  async listUsersWithoutUid(): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT id FROM users WHERE uid IS NULL')
    return (rows as Array<{ id: string }>).map((row) => row.id)
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
        [input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null],
      )
    } catch (e) {
      mapPgError(e)
    }
  }

  async findSession(tokenHash: string): Promise<SessionRow | undefined> {
    const { rows } = await this.pool.query(
      'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = $1',
      [tokenHash],
    )
    return rows.length > 0 ? toSession(rows[0] as Record<string, unknown>) : undefined
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  }

  async findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by, u.uid,
              s.expires_at
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )
    if (rows.length === 0) return undefined
    const row = rows[0] as Record<string, unknown>
    return { expiresAt: row.expires_at as number, user: toUser(row) }
  }

  async audit(actor: string | null, action: string, detail?: string | null): Promise<void> {
    await this.pool.query('INSERT INTO audit_log (ts, actor, action, detail) VALUES ($1, $2, $3, $4)', [
      Date.now(),
      actor,
      action,
      detail ?? null,
    ])
  }

  async findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined> {
    const { rows } = await this.pool.query(
      'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = $1 AND rel_path = $2',
      [userId, relPath],
    )
    return rows.length > 0 ? toWorkspace(rows[0] as Record<string, unknown>) : undefined
  }

  async getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace> {
    const existing = await this.findWorkspaceByPath(userId, relPath)
    if (existing !== undefined) return existing
    const id = randomUUID()
    const segments = relPath.split('/').filter(Boolean)
    const name = segments.at(-1) ?? 'root'
    try {
      await this.pool.query(
        'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES ($1, $2, $3, $4, $5)',
        [id, userId, name, relPath, Date.now()],
      )
    } catch (e) {
      mapPgError(e)
    }
    return { id, userId, name, relPath, createdAt: Date.now() }
  }

  async setFolderPlugins(
    workspaceId: string,
    selections: ReadonlyArray<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    try {
      await withTx(this.pool, async (client) => {
        await client.query('DELETE FROM folder_plugins WHERE workspace_id = $1', [workspaceId])
        for (const selection of selections) {
          await client.query(
            'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES ($1, $2, $3, $4)',
            [workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now()],
          )
        }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async getEnabledPluginIds(workspaceId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      'SELECT plugin_id FROM folder_plugins WHERE workspace_id = $1 AND enabled = 1',
      [workspaceId],
    )
    return (rows as Array<{ plugin_id: string }>).map((row) => row.plugin_id)
  }

  async findDomainByUser(userId: string): Promise<Domain | undefined> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = $1`, [userId])
    return rows.length > 0 ? toDomain(rows[0] as Record<string, unknown>) : undefined
  }

  async findDomainById(id: string): Promise<Domain | undefined> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains WHERE id = $1`, [id])
    return rows.length > 0 ? toDomain(rows[0] as Record<string, unknown>) : undefined
  }

  async listDomains(): Promise<Domain[]> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`)
    return rows.map((row) => toDomain(row as Record<string, unknown>))
  }

  async upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain> {
    try {
      await this.pool.query(
        `
        INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
        VALUES ($1, $2, $3, 0, $4, $5)
        ON CONFLICT(user_id) DO UPDATE SET
          domain = excluded.domain,
          verified = 0,
          nginx_config = excluded.nginx_config,
          updated_at = excluded.updated_at
        `,
        [randomUUID(), userId, domain, nginxConfig, Date.now()],
      )
    } catch (e) {
      mapPgError(e)
    }
    return (await this.findDomainByUser(userId))!
  }

  async setDomainVerified(id: string, verified: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE domains SET verified = $1, updated_at = $2 WHERE id = $3', [
      verified ? 1 : 0,
      Date.now(),
      id,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async listCredentialKeys(userId: string): Promise<CredentialKey[]> {
    const { rows } = await this.pool.query(
      'SELECT id, key_name, enabled, updated_at FROM credential_vault WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    )
    return (rows as Array<{ id: string; key_name: string; enabled: number; updated_at: number }>).map((r) => ({
      id: r.id,
      name: r.key_name,
      enabled: r.enabled === 1,
      updatedAt: r.updated_at,
    }))
  }

  async getEnabledCredentialKeyRef(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT secret_ref FROM credential_vault WHERE user_id = $1 AND enabled = 1',
      [userId],
    )
    const row = rows[0] as { secret_ref: string } | undefined
    return row?.secret_ref ?? null
  }

  async setCredentialKey(userId: string, name: string, encryptedRef: string): Promise<CredentialKey> {
    try {
      return await withTx(this.pool, async (client) => {
        await client.query('UPDATE credential_vault SET enabled = 0 WHERE user_id = $1', [userId])
        const existing = await client.query(
          'SELECT id FROM credential_vault WHERE user_id = $1 AND key_name = $2',
          [userId, name],
        )
        let id: string
        if (existing.rows.length > 0) {
          id = (existing.rows[0] as { id: string }).id
          await client.query('UPDATE credential_vault SET secret_ref = $1, enabled = 1, updated_at = $2 WHERE id = $3', [
            encryptedRef,
            Date.now(),
            id,
          ])
        } else {
          id = randomUUID()
          await client.query(
            'INSERT INTO credential_vault (id, user_id, key_name, secret_ref, enabled, updated_at) VALUES ($1, $2, $3, $4, 1, $5)',
            [id, userId, name, encryptedRef, Date.now()],
          )
        }
        return { id, name, enabled: true, updatedAt: Date.now() }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async selectCredentialKey(userId: string, id: string): Promise<boolean> {
    return await withTx(this.pool, async (client) => {
      await client.query('UPDATE credential_vault SET enabled = 0 WHERE user_id = $1', [userId])
      const result = await client.query('UPDATE credential_vault SET enabled = 1 WHERE id = $1 AND user_id = $2', [
        id,
        userId,
      ])
      return (result.rowCount ?? 0) > 0
    })
  }

  async deleteCredentialKey(userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM credential_vault WHERE id = $1 AND user_id = $2', [id, userId])
    return (result.rowCount ?? 0) > 0
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** Open a Postgres adapter: connect, run migrations, then wrap the pool. */
export async function openPgAdapter(connectionString: string, baseUid: number): Promise<PgAdapter> {
  const pool = new Pool({ connectionString })
  await runPgMigrations(pool)
  return new PgAdapter(pool, baseUid)
}
