/**
 * HTTP {@link UserFs}: every file operation is delegated to the user's own file
 * sidecar (docs/k8s.md §4.10), because the control plane runs as uid 65532 with
 * no users volume and could not touch a `0700` user directory even if it did.
 *
 * The sidecar is addressed through its per-user Headless Service. That DNS A
 * record has a ~30s TTL, so a Pod that was just rebuilt can still resolve to
 * its old IP — connection-level failures therefore drop the keep-alive pool and
 * retry once, mirroring what the DSH proxy does (docs/k8s.md §5.4).
 * @module dsh-server-login/fs/k8s-user-fs
 */

import { Agent, request as httpRequest } from 'node:http'
import type { Endpoint } from '../supervisor/spawner.js'
import { POSIX, PathEscapeError, resolveWithinRoot } from '../web/middleware/fs-guard.js'
import type { PluginInfo } from './plugins.js'
import { isUserFsErrorCode, UserFsError, type UserFs } from './user-fs.js'
import { HOME_DIR, USERS_DIR, WORKSPACE_DIR, type FsEntry } from './workspace.js'

/** Data root inside every per-user Pod (mirrors `k8s-spawner`'s POD_DATA_ROOT). */
const POD_DATA_ROOT = '/var/lib/dsh-server-login'

/** Errors that mean "the connection never got anywhere" — worth one retry
 * against a freshly resolved address. */
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ETIMEDOUT'])

/** Ensure the user's file sidecar exists and is ready; supplied by the spawner. */
export type EnsureFileService = (userId: string) => Promise<void>

interface Reply {
  status: number
  body: unknown
}

export class K8sUserFs implements UserFs {
  private agent = new Agent({ keepAlive: true, maxSockets: 16 })

  /**
   * @param ensureFileService - brings the sidecar up before the first call.
   * @param endpointFor - the sidecar's address; the k8s backend supplies the
   * per-user Headless Service DNS, tests supply a loopback bind.
   */
  constructor(
    private readonly ensureFileService: EnsureFileService,
    private readonly endpointFor: (userId: string) => Endpoint,
  ) {}

  async initUserRoot(userId: string): Promise<void> {
    // Creating the sidecar Pod *is* the initialization: its init container
    // builds `<pvc>/<userId>/{ws,home}` as the user's own uid (docs/k8s.md §4.9).
    await this.ensureFileService(userId)
    await this.call(userId, 'POST', '/fs/init')
  }

  resolvePath(userId: string, relPath: string): string {
    const root = `${POD_DATA_ROOT}/${USERS_DIR}/${userId}/${WORKSPACE_DIR}`
    try {
      return resolveWithinRoot(root, relPath, POSIX)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_path')
      throw err
    }
  }

  /** The user's DSH state directory inside their Pod. */
  homePath(userId: string): string {
    return `${POD_DATA_ROOT}/${USERS_DIR}/${userId}/${HOME_DIR}`
  }

  async listDir(userId: string, relPath: string): Promise<FsEntry[]> {
    const body = await this.call(userId, 'GET', `/fs/tree?path=${encodeURIComponent(relPath)}`)
    return (body as { entries: FsEntry[] }).entries
  }

  async mkdir(userId: string, relPath: string): Promise<void> {
    await this.call(userId, 'POST', '/fs/mkdir', { path: relPath })
  }

  async createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string> {
    const body = await this.call(userId, 'POST', '/fs/create', { path: relPath, name, type })
    return (body as { name: string }).name
  }

  async upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string> {
    const body = await this.call(userId, 'POST', '/fs/upload', {
      path: relPath,
      name,
      data: data.toString('base64'),
    })
    return (body as { name: string }).name
  }

  async isDirectory(userId: string, relPath: string): Promise<boolean> {
    const body = await this.call(userId, 'GET', `/fs/stat?path=${encodeURIComponent(relPath)}`)
    return (body as { isDirectory: boolean }).isDirectory
  }

  async listInstalledPlugins(userId: string): Promise<PluginInfo[]> {
    const body = await this.call(userId, 'GET', '/fs/plugins')
    return (body as { plugins: PluginInfo[] }).plugins
  }

  async writeHandoff(userId: string, content: string): Promise<void> {
    await this.call(userId, 'POST', '/fs/handoff', { content })
  }

  /** One sidecar call: ensure the Pod, send, retry once on a dead connection,
   * then translate a non-2xx `{error}` back into a {@link UserFsError}. */
  private async call(userId: string, method: string, path: string, payload?: unknown): Promise<unknown> {
    await this.ensureFileService(userId)
    let reply: Reply
    try {
      reply = await this.send(userId, method, path, payload)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === undefined || !RETRYABLE.has(code)) throw err
      // The keep-alive pool may hold sockets to a Pod IP that no longer exists;
      // drop them so the retry re-resolves the Headless Service.
      this.agent.destroy()
      this.agent = new Agent({ keepAlive: true, maxSockets: 16 })
      reply = await this.send(userId, method, path, payload)
    }
    if (reply.status >= 200 && reply.status < 300) return reply.body
    const error = (reply.body as { error?: unknown }).error
    if (typeof error === 'string' && isUserFsErrorCode(error)) throw new UserFsError(error)
    throw new Error(`file sidecar for ${userId} returned ${reply.status}`)
  }

  private send(userId: string, method: string, path: string, payload?: unknown): Promise<Reply> {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const endpoint = this.endpointFor(userId)
    return new Promise<Reply>((resolve, reject) => {
      const req = httpRequest(
        {
          host: endpoint.host,
          port: endpoint.port,
          path,
          method,
          agent: this.agent,
          headers: body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            try {
              resolve({ status: res.statusCode ?? 502, body: text === '' ? {} : JSON.parse(text) })
            } catch {
              reject(new Error(`file sidecar for ${userId} returned non-JSON (${res.statusCode})`))
            }
          })
        },
      )
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }
}
