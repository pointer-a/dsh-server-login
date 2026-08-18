/**
 * Path-traversal guard for every filesystem-facing surface.
 *
 * Skeleton: the `..`/NUL/absolute checks below are real; the `realpath`
 * symlink-escape verification is a P2 task (needs the live per-user root).
 * @module dsh-server-login/web/middleware/fs-guard
 */
/** Sentinel error for a path that escapes its allowed root. */
export declare class PathEscapeError extends Error {
    constructor(path: string, root: string);
}
/**
 * Resolve `candidate` against `root` and reject anything that escapes it.
 * @param root - the user's workspace root (absolute).
 * @param candidate - a user-supplied relative path.
 * @returns the canonicalized absolute path inside `root`.
 */
export declare function assertWithinRoot(root: string, candidate: string): string;
