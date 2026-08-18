/**
 * Plugin listing / selection routes. Stubs until P4 wires the installed-plugin
 * allowlist and `folder_plugins` persistence.
 * @module dsh-server-login/web/routes/plugins
 */
import { requireAuth } from '../middleware/authn.js';
export const pluginRoutes = async (app) => {
    app.get('/api/plugins', { preHandler: requireAuth }, async () => ({ todo: true, route: 'list-plugins' }));
    app.post('/api/plugins/select', { preHandler: requireAuth }, async () => ({ todo: true, route: 'select-plugins' }));
};
//# sourceMappingURL=plugins.js.map