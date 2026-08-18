/**
 * Reverse proxy from the orchestrator to a running per-user DSH web UI.
 *
 * P3 proxies plain HTTP. WebSocket upgrade and absolute-path/Location rewriting
 * are deferred (see docs/blueprint.md §1b) — nginx in P6 is the intended
 * termination point for those.
 * @module dsh-server-login/supervisor/proxy
 */
import type { FastifyInstance } from 'fastify';
/**
 * Register the authenticated `/u/:slug/dsh/*` proxy. The `:slug` is the user id;
 * a caller can only proxy their own instance.
 */
export declare function registerDshProxy(app: FastifyInstance): Promise<void>;
