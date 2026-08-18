/**
 * Reverse proxy from the orchestrator to a running per-user DSH.
 *
 * Two entry points:
 * - subpath `/u/:slug/dsh/*` (authenticated, legacy), and
 * - per-user subdomain `<username>.<baseDomain>` (HTTP + WebSocket). The DSH's
 *   absolute-path SPA requires the subdomain form: its `/assets/*` and `/api/*`
 *   resolve against the host root, which only works when each DSH owns a host.
 * @module dsh-server-login/supervisor/proxy
 */
import type { FastifyInstance } from 'fastify';
/** Extract `<slug>` from `<slug>.<baseDomain>`, or null when not a match. */
export declare function parseSubdomain(host: string | undefined, baseDomain: string): string | null;
/** The per-user subdomain for a username, or null when `baseDomain` is unset. */
export declare function subdomainForUser(baseDomain: string, username: string): string | null;
export declare function registerDshProxy(app: FastifyInstance): Promise<void>;
