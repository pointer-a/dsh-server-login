/**
 * Plugin listing / per-folder selection routes. The catalog comes from config;
 * selections are persisted to `folder_plugins` (keyed by the folder workspace)
 * and injected into the child DSH at launch.
 * @module dsh-server-login/web/routes/plugins
 */
import type { FastifyPluginAsync } from 'fastify';
export declare const pluginRoutes: FastifyPluginAsync;
