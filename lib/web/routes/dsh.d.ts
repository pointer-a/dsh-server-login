/**
 * DSH launch / supervise routes + the reverse proxy to a running instance.
 * Launch resolves the requested folder against the caller's workspace, reads
 * the folder's enabled plugins, writes a cordis patch for them, and spawns one
 * main DSH; stop/status drive the supervisor.
 * @module dsh-server-login/web/routes/dsh
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const dshRoutes: FastifyPluginAsync;
