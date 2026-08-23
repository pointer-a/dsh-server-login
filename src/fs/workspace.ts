/**
 * Per-user filesystem layout + low-level helpers. This module is the single
 * place that knows the `users/<id>/{home,ws}` shape — the control plane, the
 * local spawner, the k8s Pod spec, and the file sidecar all derive their paths
 * from here so the four never drift apart.
 *
 * Isolation is enforced by the caller (see fs-guard).
 * @module dsh-server-login/fs/workspace
 */

import { mkdirSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Layout segment names. Exported so the k8s Pod spec can build the same layout
// with POSIX separators (`join` would emit backslashes when the control plane
// is developed/tested on Windows) without duplicating the literals.
export const USERS_DIR = 'users'
export const WORKSPACE_DIR = 'ws'
export const HOME_DIR = 'home'
export const HANDOFF_FILE = 'handoff.json'

/** A user's own data root (`<dataRoot>/users/<id>`). */
export function userRoot(dataRoot: string, userId: string): string {
  return join(dataRoot, USERS_DIR, userId)
}

/** The workspace (user-visible files) within a user root. */
export function workspaceRoot(root: string): string {
  return join(root, WORKSPACE_DIR)
}

/** DSH's own state (profiles/sessions/credentials) within a user root. */
export function homeRoot(root: string): string {
  return join(root, HOME_DIR)
}

/** The watchdog command handoff within a user root. */
export function handoffPath(root: string): string {
  return join(root, HANDOFF_FILE)
}

/** Create a directory (0700) if it does not exist. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

/** One filesystem entry as returned to the desktop. */
export interface FsEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtimeMs: number
}

/** List the immediate children of a directory (async, non-blocking). */
export async function listDir(absPath: string): Promise<FsEntry[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const result: FsEntry[] = []
  for (const entry of entries) {
    const st = await stat(join(absPath, entry.name))
    result.push({
      name: entry.name,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      mtimeMs: st.mtimeMs,
    })
  }
  return result
}
