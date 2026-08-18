/**
 * Per-user workspace filesystem helpers. The workspace root is derived from
 * `dataRoot` + the user id, so it is deterministic and never needs to round-trip
 * through the DB. Isolation is enforced by the caller (see fs-guard).
 * @module dsh-server-login/fs/workspace
 */
import type { ServerConfig } from '../config.js';
/** Absolute workspace root for a user (`<dataRoot>/users/<id>/ws`). */
export declare function workspaceRoot(config: ServerConfig, userId: string): string;
/** Create the workspace root (0700) if it does not exist. */
export declare function ensureWorkspaceRoot(root: string): void;
/** One filesystem entry as returned to the desktop. */
export interface FsEntry {
    name: string;
    type: 'file' | 'dir';
    size: number;
    mtimeMs: number;
}
/** List the immediate children of a directory. */
export declare function listDir(absPath: string): FsEntry[];
