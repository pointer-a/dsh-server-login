/**
 * Account-level isolation helpers. Linux-only: each user maps to a deterministic
 * OS uid so the orchestrator can spawn its DSH as that account (via setuid) and
 * per-user 0700 directories become a real boundary.
 * @module dsh-server-login/isolation
 */
/**
 * Deterministic OS uid for a user id (stable across restarts and hosts).
 * `baseUid` should sit above the distro's system uid range (typically < 1000).
 */
export declare function uidForUser(userId: string, baseUid: number): number;
