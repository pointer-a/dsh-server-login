/**
 * Per-user workspace filesystem helpers. The workspace root is derived from
 * `dataRoot` + the user id, so it is deterministic and never needs to round-trip
 * through the DB. Isolation is enforced by the caller (see fs-guard).
 * @module dsh-server-login/fs/workspace
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** Absolute workspace root for a user (`<dataRoot>/users/<id>/ws`). */
export function workspaceRoot(config, userId) {
    return join(config.dataRoot, 'users', userId, 'ws');
}
/** Create the workspace root (0700) if it does not exist. */
export function ensureWorkspaceRoot(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
}
/** List the immediate children of a directory. */
export function listDir(absPath) {
    const entries = readdirSync(absPath, { withFileTypes: true });
    return entries.map((entry) => {
        const stat = statSync(join(absPath, entry.name));
        return {
            name: entry.name,
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.isFile() ? stat.size : 0,
            mtimeMs: stat.mtimeMs,
        };
    });
}
//# sourceMappingURL=workspace.js.map