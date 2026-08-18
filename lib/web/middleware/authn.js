/**
 * Authentication / authorization guards.
 *
 * `requireAuth` resolves the session cookie into `request.user` (a PublicUser)
 * with a single `sessions JOIN users` lookup; `requireAdmin` additionally
 * enforces the admin role. Both reject with 401/403 and never continue the
 * handler.
 * @module dsh-server-login/web/middleware/authn
 */
import { findSessionWithUser, toPublicUser } from '../../db/repo.js';
import { hashSessionToken, parseCookie } from '../auth.js';
/** Resolve the session cookie into `request.user`, or reject 401. */
export async function requireAuth(request, reply) {
    const token = parseCookie(request.headers.cookie, 'sid');
    if (token === undefined) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
    }
    const row = findSessionWithUser(request.server.db, hashSessionToken(token));
    if (row === undefined || row.expiresAt <= Date.now() || row.user.role === 'disabled') {
        reply.code(401).send({ error: 'unauthorized' });
        return;
    }
    request.user = toPublicUser(row.user);
}
/** Require an authenticated admin; rejects non-admins with 403. */
export async function requireAdmin(request, reply) {
    await requireAuth(request, reply);
    if (request.user === null)
        return; // requireAuth already sent the response
    if (request.user.role !== 'admin') {
        reply.code(403).send({ error: 'forbidden' });
        return;
    }
}
//# sourceMappingURL=authn.js.map