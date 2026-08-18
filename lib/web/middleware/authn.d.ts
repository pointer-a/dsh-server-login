/**
 * Authentication / authorization guards.
 *
 * `requireAuth` resolves the session cookie into `request.user` (a PublicUser);
 * `requireAdmin` additionally enforces the admin role. Both reject with 401/403
 * and never continue the handler.
 * @module dsh-server-login/web/middleware/authn
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
/** Resolve the session cookie into `request.user`, or reject 401. */
export declare function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
/** Require an authenticated admin; rejects non-admins with 403. */
export declare function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
