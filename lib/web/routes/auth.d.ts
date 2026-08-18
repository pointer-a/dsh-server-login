/**
 * Auth routes: self-registration (→ pending), login, logout, and the current
 * identity. Registration always yields a `pending` user; an admin approves it.
 * @module dsh-server-login/web/routes/auth
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const authRoutes: FastifyPluginAsync;
