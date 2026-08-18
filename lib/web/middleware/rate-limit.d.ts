/**
 * Global rate limiting. The auth/admin surfaces get their own stricter limits
 * in P1; this baseline covers the whole server.
 * @module dsh-server-login/web/middleware/rate-limit
 */
import type { FastifyPluginAsync } from 'fastify';
/** Register the baseline rate limiter (applies to all routes). */
export declare const rateLimit: FastifyPluginAsync;
