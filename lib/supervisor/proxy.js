/**
 * Reverse proxy from the orchestrator to a running per-user DSH web UI.
 *
 * Skeleton — P3 looks up the instance's loopback port and pipes the request,
 * rewriting `Location` and the base path for the `/u/:slug/dsh/*` prefix.
 * @module dsh-server-login/supervisor/proxy
 */
/**
 * Register the `/u/:slug/dsh/*` proxy route. Stub returns 501 until P3.
 */
export async function registerDshProxy(app) {
    app.get('/u/:slug/dsh/*', async (_request, reply) => {
        reply.code(501).send({ todo: true, route: 'dsh-proxy' });
    });
}
//# sourceMappingURL=proxy.js.map