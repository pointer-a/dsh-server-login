/**
 * DSH launch / supervise / restart routes + the reverse proxy to a running
 * instance. Launch resolves the requested folder, reads its enabled plugins,
 * writes a cordis patch, and spawns a main+watchdog pair; restart writes a
 * post-restart command handoff and respawns the main.
 * @module dsh-server-login/web/routes/dsh
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const dshRoutes: FastifyPluginAsync;
