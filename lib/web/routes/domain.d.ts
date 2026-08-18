/**
 * Custom-domain routes: set/get a user's domain, regenerate its nginx config,
 * and admin verification. Real ACME/DNS ownership verification is deferred;
 * the `verified` flag is set by an admin as a placeholder until then.
 * @module dsh-server-login/web/routes/domain
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const domainRoutes: FastifyPluginAsync;
