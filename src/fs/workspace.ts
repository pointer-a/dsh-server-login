/**
 * Per-user workspace filesystem helpers. The workspace root is derived from
 * `dataRoot` + the user id, so it is deterministic and never needs to round-trip
 * through the DB. Isolation is enforced by the caller (see fs-guard).
 * @module dsh-server-login/fs/workspace
 */

import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerConfig } from '../config.js'

/** Absolute workspace root for a user (`<dataRoot>/users/<id>/ws`). */
export function workspaceRoot(config: ServerConfig, userId: string): string {
  return join(config.dataRoot, 'users', userId, 'ws')
}

/** Create the workspace root (0700) if it does not exist. */
export function ensureWorkspaceRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
}

/** One filesystem entry as returned to the desktop. */
export interface FsEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtimeMs: number
}

/** List the immediate children of a directory. */
export function listDir(absPath: string): FsEntry[] {
  const entries = readdirSync(absPath, { withFileTypes: true })
  return entries.map((entry) => {
    const stat = statSync(join(absPath, entry.name))
    return {
      name: entry.name,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isFile() ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
    }
  })
}
