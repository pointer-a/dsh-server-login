/**
 * Custom-domain / nginx routes. Stubs until P6 wires ACME verification and
 * nginx config generation.
 * @module dsh-server-login/web/routes/domain
 */
import { requireAuth } from '../middleware/authn.js';
export const domainRoutes = async (app) => {
    app.get('/api/domain', { preHandler: requireAuth }, async () => ({ todo: true, route: 'get-domain' }));
    app.put('/api/domain', { preHandler: requireAuth }, async () => ({ todo: true, route: 'set-domain' }));
    app.post('/api/nginx/regen', { preHandler: requireAuth }, async () => ({ todo: true, route: 'regen-nginx' }));
};
//# sourceMappingURL=domain.js.map