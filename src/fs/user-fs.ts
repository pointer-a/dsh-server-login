/**
 * The per-user filesystem seam (docs/k8s.md §4.10 / §6.0-1).
 *
 * Under `local` the control plane owns the users volume and touches it directly
 * ({@link LocalUserFs}). Under `k8s` it must not: it runs as uid 65532 while
 * each user's directory is `0700` owned by that user's uid, so every file
 * operation is delegated over HTTP to a per-user file sidecar
 * ({@link K8sUserFs}). Routes depend only on this interface.
 *
 * All paths crossing this interface are **workspace-relative**; each
 * implementation resolves them against its own root via `resolveWithinRoot`.
 * @module dsh-server-login/fs/user-fs
 */

import type { PluginInfo } from './plugins.js'
import type { FsEntry } from './workspace.js'

/** Wire-level failure codes. These are the exact `{error}` values the desktop
 * UI already switches on, so they survive the control-plane ↔ sidecar hop. */
export type UserFsErrorCode =
  | 'bad_path'
  | 'bad_name'
  | 'not_found'
  | 'exists'
  | 'parent_missing'
  | 'not_a_folder'

/** HTTP status each code maps to (unchanged from the pre-seam routes). */
const STATUS: Record<UserFsErrorCode, number> = {
  bad_path: 400,
  bad_name: 400,
  not_found: 404,
  exists: 409,
  parent_missing: 404,
  not_a_folder: 400,
}

/**
 * A filesystem failure already reduced to its wire form. Routes rethrow it as
 * `reply.code(err.status).send({ error: err.code })` without inspecting errno,
 * which is what lets the k8s implementation rebuild it from a sidecar response.
 */
export class UserFsError extends Error {
  readonly status: number

  constructor(readonly code: UserFsErrorCode) {
    super(code)
    this.name = 'UserFsError'
    this.status = STATUS[code]
  }
}

/** True when `code` is one this seam knows how to represent. */
export function isUserFsErrorCode(code: string): code is UserFsErrorCode {
  return code in STATUS
}

/** Per-user filesystem operations, as the route layer needs them. */
export interface UserFs {
  /** Create the user's home/workspace roots (`0700`). Idempotent. */
  initUserRoot(userId: string): Promise<void>
  /** Absolute path of `relPath` **as the user's DSH process sees it** (pure path
   * math — the in-Pod mount path under k8s, the host path under local). */
  resolvePath(userId: string, relPath: string): string
  listDir(userId: string, relPath: string): Promise<FsEntry[]>
  mkdir(userId: string, relPath: string): Promise<void>
  /** Create a file or directory under `relPath`; returns the sanitized name. */
  createEntry(userId: string, relPath: string, name: string, type: 'file' | 'dir'): Promise<string>
  /** Write `data` as `name` under `relPath`; returns the sanitized name. */
  upload(userId: string, relPath: string, name: string, data: Buffer): Promise<string>
  /** Whether `relPath` is a directory; throws `not_found` when absent. */
  isDirectory(userId: string, relPath: string): Promise<boolean>
  listInstalledPlugins(userId: string): Promise<PluginInfo[]>
  /** Write the post-restart command handoff the watchdog reads. */
  writeHandoff(userId: string, content: string): Promise<void>
}
