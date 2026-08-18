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
export function uidForUser(userId, baseUid) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++)
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    return baseUid + (hash % 100000);
}
//# sourceMappingURL=isolation.js.map