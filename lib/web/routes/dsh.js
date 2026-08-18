/**
 * DSH launch / supervise routes + reverse proxy to a running instance's UI.
 * Stubs until P3 lands the supervisor; the proxy shape is already pinned.
 * @module dsh-server-login/web/routes/dsh
 */
import { requireAuth } from '../middleware/authn.js';
import { registerDshProxy } from '../../supervisor/proxy.js';
export const dshRoutes = async (app) => {
    app.post('/api/dsh/launch', { preHandler: requireAuth }, async () => ({ todo: true, route: 'launch' }));
    app.post('/api/dsh/stop', { preHandler: requireAuth }, async () => ({ todo: true, route: 'stop' }));
    app.get('/api/dsh/status', { preHandler: requireAuth }, async () => ({ todo: true, route: 'status' }));
    await registerDshProxy(app);
};
//# sourceMappingURL=dsh.js.map