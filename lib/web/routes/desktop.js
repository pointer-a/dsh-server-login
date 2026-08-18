/**
 * Desktop / filesystem routes: list files, create a folder workspace, upload.
 * Stubs until P2 wires the per-user filesystem root + fs-guard.
 * @module dsh-server-login/web/routes/desktop
 */
import { requireAuth } from '../middleware/authn.js';
export const desktopRoutes = async (app) => {
    app.get('/api/desktop/tree', { preHandler: requireAuth }, async () => ({ todo: true, route: 'tree' }));
    app.post('/api/fs/mkdir', { preHandler: requireAuth }, async () => ({ todo: true, route: 'mkdir' }));
    app.post('/api/fs/upload', { preHandler: requireAuth }, async () => ({ todo: true, route: 'upload' }));
};
//# sourceMappingURL=desktop.js.map