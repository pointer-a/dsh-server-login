/**
 * Admin routes: list users and approve/disable accounts. All guarded by
 * `requireAdmin`.
 * @module dsh-server-login/web/routes/admin
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const adminRoutes: FastifyPluginAsync;
