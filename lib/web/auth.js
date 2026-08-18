/**
 * Password hashing, session-token helpers, and cookie assembly.
 *
 * Uses `node:crypto` scrypt so the scaffold has zero native dependency beyond
 * SQLite; production may swap in argon2id without changing call sites.
 * @module dsh-server-login/web/auth
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
/** Hash a password into a `scrypt$<salt>$<hash>` string. */
export async function hashPassword(password) {
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, KEY_LENGTH);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}
/** Constant-time password verification against a stored `scrypt$...` string. */
export async function verifyPassword(password, stored) {
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined)
        return false;
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
}
/** Generate a fresh opaque session token. */
export function newSessionToken() {
    return randomBytes(32).toString('base64url');
}
/** Hash a session token for storage; the DB never holds the raw token. */
export function hashSessionToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
/** Extract a named cookie value from a `Cookie` header. */
export function parseCookie(header, name) {
    if (!header)
        return undefined;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1)
            continue;
        if (part.slice(0, idx).trim() === name)
            return part.slice(idx + 1).trim();
    }
    return undefined;
}
/** Build a `Set-Cookie` value for the session token. */
export function sessionCookie(token, maxAgeSeconds, secure, domain) {
    const flags = ['sid=' + token, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`];
    if (secure)
        flags.push('Secure');
    if (domain !== undefined && domain !== '')
        flags.push(`Domain=${domain}`);
    return flags.join('; ');
}
/** Build a `Set-Cookie` value that expires the session cookie. */
export function clearSessionCookie(secure, domain) {
    const flags = ['sid=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
    if (secure)
        flags.push('Secure');
    if (domain !== undefined && domain !== '')
        flags.push(`Domain=${domain}`);
    return flags.join('; ');
}
//# sourceMappingURL=auth.js.map