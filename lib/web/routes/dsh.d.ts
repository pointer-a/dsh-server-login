/**
 * DSH launch / supervise routes + reverse proxy to a running instance's UI.
 * Stubs until P3 lands the supervisor; the proxy shape is already pinned.
 * @module dsh-server-login/web/routes/dsh
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const dshRoutes: FastifyPluginAsync;
