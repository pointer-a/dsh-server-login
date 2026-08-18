/**
 * Desktop / filesystem routes: list the user's workspace, create a folder, and
 * upload a file. Every path is resolved against the caller's own workspace
 * root, so one user can never address another user's files.
 * @module dsh-server-login/web/routes/desktop
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const desktopRoutes: FastifyPluginAsync;
