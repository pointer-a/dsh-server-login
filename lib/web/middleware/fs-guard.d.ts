/**
 * Path-traversal guard for every filesystem-facing surface.
 *
 * `resolveWithinRoot` canonicalizes a user-supplied relative path against a
 * root and rejects anything that escapes it; `safeFilename` strips directory
 * components from an upload name.
 * @module dsh-server-login/web/middleware/fs-guard
 */
/** Sentinel error for a path that escapes its allowed root. */
export declare class PathEscapeError extends Error {
    constructor(path: string, root: string);
}
/**
 * Resolve `rel` against `root` and reject absolute paths, NUL bytes, and any
 * result that escapes the root (including `..` traversal).
 * @param root - the user's workspace root (absolute).
 * @param rel - a user-supplied relative path (`''` resolves to `root`).
 */
export declare function resolveWithinRoot(root: string, rel: string): string;
/**
 * Reduce an upload filename to its base name, rejecting empty/dot/NUL names so
 * a client cannot smuggle a path component.
 */
export declare function safeFilename(name: string): string;
