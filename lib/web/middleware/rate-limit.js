/**
 * Global rate limiting. The auth/admin surfaces get their own stricter limits
 * in P1; this baseline covers the whole server.
 * @module dsh-server-login/web/middleware/rate-limit
 */
import fastifyRateLimit from '@fastify/rate-limit';
/** Register the baseline rate limiter (applies to all routes). */
export const rateLimit = async (app) => {
    await app.register(fastifyRateLimit, {
        max: 100,
        timeWindow: '1 minute',
        global: true,
    });
};
//# sourceMappingURL=rate-limit.js.map