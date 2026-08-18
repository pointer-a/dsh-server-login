/**
 * Desktop / filesystem routes: list the user's workspace, create a folder, and
 * upload a file. Every path is resolved against the caller's own workspace
 * root, so one user can never address another user's files.
 * @module dsh-server-login/web/routes/desktop
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../middleware/authn.js';
import { resolveWithinRoot, safeFilename } from '../middleware/fs-guard.js';
import { ensureWorkspaceRoot, listDir, workspaceRoot } from '../../fs/workspace.js';
const mkdirSchema = {
    body: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
        properties: { path: { type: 'string', maxLength: 512 } },
    },
};
const uploadSchema = {
    body: {
        type: 'object',
        required: ['path', 'name', 'data'],
        additionalProperties: false,
        properties: {
            path: { type: 'string', maxLength: 512 },
            name: { type: 'string', maxLength: 255 },
            data: { type: 'string' },
        },
    },
};
export const desktopRoutes = async (app) => {
    app.get('/api/desktop/tree', { preHandler: requireAuth }, async (request, reply) => {
        const { path = '' } = request.query;
        const root = workspaceRoot(app.config, request.user.id);
        ensureWorkspaceRoot(root);
        let abs;
        try {
            abs = resolveWithinRoot(root, path);
        }
        catch {
            return reply.code(400).send({ error: 'bad_path' });
        }
        try {
            return { path, entries: listDir(abs) };
        }
        catch {
            return reply.code(404).send({ error: 'not_found' });
        }
    });
    app.post('/api/fs/mkdir', { preHandler: requireAuth, schema: mkdirSchema }, async (request, reply) => {
        const { path } = request.body;
        const root = workspaceRoot(app.config, request.user.id);
        ensureWorkspaceRoot(root);
        let abs;
        try {
            abs = resolveWithinRoot(root, path);
        }
        catch {
            return reply.code(400).send({ error: 'bad_path' });
        }
        try {
            mkdirSync(abs);
            return { ok: true };
        }
        catch (err) {
            const code = err.code;
            if (code === 'EEXIST')
                return reply.code(409).send({ error: 'exists' });
            if (code === 'ENOENT')
                return reply.code(404).send({ error: 'parent_missing' });
            throw err;
        }
    });
    app.post('/api/fs/upload', { preHandler: requireAuth, schema: uploadSchema }, async (request, reply) => {
        const { path, name, data } = request.body;
        const root = workspaceRoot(app.config, request.user.id);
        ensureWorkspaceRoot(root);
        let dirAbs;
        try {
            dirAbs = resolveWithinRoot(root, path);
        }
        catch {
            return reply.code(400).send({ error: 'bad_path' });
        }
        let filename;
        try {
            filename = safeFilename(name);
        }
        catch {
            return reply.code(400).send({ error: 'bad_name' });
        }
        let buf;
        try {
            buf = Buffer.from(data, 'base64');
        }
        catch {
            return reply.code(400).send({ error: 'bad_data' });
        }
        try {
            writeFileSync(join(dirAbs, filename), buf);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return reply.code(404).send({ error: 'parent_missing' });
            throw err;
        }
        return { ok: true, name: filename };
    });
};
//# sourceMappingURL=desktop.js.map