/**
 * Password hashing, session-token helpers, and cookie assembly.
 *
 * Uses `node:crypto` scrypt so the scaffold has zero native dependency beyond
 * SQLite; production may swap in argon2id without changing call sites.
 * @module dsh-server-login/web/auth
 */
/** Hash a password into a `scrypt$<salt>$<hash>` string. */
export declare function hashPassword(password: string): Promise<string>;
/** Constant-time password verification against a stored `scrypt$...` string. */
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
/** Generate a fresh opaque session token. */
export declare function newSessionToken(): string;
/** Hash a session token for storage; the DB never holds the raw token. */
export declare function hashSessionToken(token: string): string;
/** Extract a named cookie value from a `Cookie` header. */
export declare function parseCookie(header: string | undefined, name: string): string | undefined;
/** Build a `Set-Cookie` value for the session token. */
export declare function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string;
/** Build a `Set-Cookie` value that expires the session cookie. */
export declare function clearSessionCookie(secure: boolean): string;
