/**
 * Direct-filesystem {@link UserFs}: the control plane owns the users volume and
 * touches it in-process. This is the `deployMode=local` implementation, and it
 * is also what the per-user file sidecar runs behind its HTTP surface — the
 * sidecar is just a `LocalUserFs` pinned to one user's root.
 * @module dsh-server-login/fs/local-user-fs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PathEscapeError, resolveWithinRoot, safeFilename } from '../web/middleware/fs-guard.js'
import { listInstalledPlugins, type PluginInfo } from './plugins.js'
import { UserFsError, type UserFs } from './user-fs.js'
import { ensureDir, handoffPath, homeRoot, listDir, workspaceRoot, type FsEntry } from './workspace.js'

/** Resolve a user id to that user's data root (`<dataRoot>/users/<id>`, or a
 * fixed directory when the sidecar serves exactly one user). */
export type UserRootResolver = (userId: string) => string

/** Map a Node errno onto the wire code the desktop already handles. */
function fsError(err: unknown, onMissing: 'not_found' | 'parent_missing'): never {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EEXIST') throw new UserFsError('exists')
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new UserFsError(onMissing)
  throw err
}

export class LocalUserFs implements UserFs {
  constructor(private readonly rootFor: UserRootResolver) {}

  async initUserRoot(userId: string): Promise<void> {
    const root = this.rootFor(userId)
    ensureDir(homeRoot(root))
    ensureDir(workspaceRoot(root))
  }

  resolvePath(userId: string, relPath: string): string {
    return this.resolve(userId, relPath)
  }

  async listDir(userId: string, relPath: string): Promise<FsEntry[]> {
    const abs = this.resolve(userId, relPath)
    try {
      return await listDir(abs)
    } catch (err) {
      fsError(err, 'not_found')
    }
  }

  async mkdir(userId: string, relPath: string): Promise<void> {
    const abs = this.resolve(userId, relPath)
    try {
      await mkdir(abs)
    } catch (err) {
      fsError(err, 'parent_missing')
    }
  }

  async createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string> {
    const dirAbs = this.resolve(userId, relPath)
    const filename = this.sanitize(name)
    const target = join(dirAbs, filename)
    try {
      if (type === 'dir') await mkdir(target)
      else await writeFile(target, '')
    } catch (err) {
      fsError(err, 'parent_missing')
    }
    return filename
  }

  async upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string> {
    const dirAbs = this.resolve(userId, relPath)
    const filename = this.sanitize(name)
    try {
      await writeFile(join(dirAbs, filename), data)
    } catch (err) {
      fsError(err, 'parent_missing')
    }
    return filename
  }

  async isDirectory(userId: string, relPath: string): Promise<boolean> {
    const abs = this.resolve(userId, relPath)
    try {
      return (await stat(abs)).isDirectory()
    } catch (err) {
      fsError(err, 'not_found')
    }
  }

  async listInstalledPlugins(userId: string): Promise<PluginInfo[]> {
    return listInstalledPlugins(this.rootFor(userId))
  }

  async writeHandoff(userId: string, content: string): Promise<void> {
    const root = this.rootFor(userId)
    ensureDir(root)
    await writeFile(handoffPath(root), content)
  }

  /** Resolve a workspace-relative path, self-healing the root the way the
   * pre-seam routes did (every one of them called `ensureWorkspaceRoot` first). */
  private resolve(userId: string, relPath: string): string {
    const ws = workspaceRoot(this.rootFor(userId))
    ensureDir(ws)
    try {
      return resolveWithinRoot(ws, relPath)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_path')
      throw err
    }
  }

  private sanitize(name: string): string {
    try {
      return safeFilename(name)
    } catch (err) {
      if (err instanceof PathEscapeError) throw new UserFsError('bad_name')
      throw err
    }
  }
}
