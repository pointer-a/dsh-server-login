/**
 * Authentication / authorization guards.
 *
 * `requireAuth` resolves the session cookie into `request.user` (a PublicUser);
 * `requireAdmin` additionally enforces the admin role. Both reject with 401/403
 * and never continue the handler.
 * @module dsh-server-login/web/middleware/authn
 */
import { findSession, findUserById, toPublicUser } from '../../db/repo.js';
import { hashSessionToken, parseCookie } from '../auth.js';
/** Resolve the session cookie into `request.user`, or reject 401. */
export async function requireAuth(request, reply) {
    const token = parseCookie(request.headers.cookie, 'sid');
    if (token === undefined) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
    }
    const session = findSession(request.server.db, hashSessionToken(token));
    if (session === undefined || session.expires_at <= Date.now()) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
    }
    const user = findUserById(request.server.db, session.user_id);
    if (user === undefined || user.role === 'disabled') {
        reply.code(401).send({ error: 'unauthorized' });
        return;
    }
    request.user = toPublicUser(user);
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