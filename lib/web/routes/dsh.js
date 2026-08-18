/**
 * DSH launch / supervise / restart routes + the reverse proxy to a running
 * instance. Launch resolves the requested folder, reads its enabled plugins,
 * writes a cordis patch, and spawns a main+watchdog pair; restart writes a
 * post-restart command handoff and respawns the main.
 * @module dsh-server-login/web/routes/dsh
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireAuth } from '../middleware/authn.js';
import { resolveWithinRoot } from '../middleware/fs-guard.js';
import { ensureWorkspaceRoot, workspaceRoot } from '../../fs/workspace.js';
import { findWorkspaceByPath, getEnabledPluginIds } from '../../db/repo.js';
import { AlreadyRunningError } from '../../supervisor/orchestrator.js';
import { renderPatch } from '../../supervisor/patch.js';
import { subdomainForUser } from '../../supervisor/proxy.js';
const launchSchema = {
    body: {
        type: 'object',
        required: ['folder'],
        additionalProperties: false,
        properties: { folder: { type: 'string', maxLength: 512 } },
    },
};
const restartSchema = {
    body: {
        type: 'object',
        required: ['command'],
        additionalProperties: false,
        properties: { command: { type: 'string', maxLength: 1024 } },
    },
};
function alive(status) {
    return status !== undefined && status !== 'crashed' && status !== 'stopped';
}
function dshUrl(baseDomain, user) {
    const sub = subdomainForUser(baseDomain, user.username);
    return sub !== null ? `https://${sub}/` : `/u/${user.id}/dsh/`;
}
export const dshRoutes = async (app) => {
    app.post('/api/dsh/launch', { preHandler: requireAuth, schema: launchSchema }, async (request, reply) => {
        const { folder } = request.body;
        const user = request.user;
        const root = workspaceRoot(app.config, user.id);
        ensureWorkspaceRoot(root);
        let folderAbs;
        try {
            folderAbs = resolveWithinRoot(root, folder);
        }
        catch {
            return reply.code(400).send({ error: 'bad_path' });
        }
        try {
            if (!statSync(folderAbs).isDirectory())
                return reply.code(400).send({ error: 'not_a_folder' });
        }
        catch {
            return reply.code(404).send({ error: 'not_found' });
        }
        let patchPath;
        const workspace = findWorkspaceByPath(app.db, user.id, folder);
        if (workspace !== undefined) {
            const enabled = getEnabledPluginIds(app.db, workspace.id);
            if (enabled.length > 0) {
                const patchesDir = join(app.config.dataRoot, 'users', user.id, 'patches');
                mkdirSync(patchesDir, { recursive: true });
                patchPath = join(patchesDir, `${workspace.id}.yml`);
                writeFileSync(patchPath, renderPatch(enabled));
            }
        }
        try {
            const instance = await app.supervisor.launch(user.id, folderAbs, patchPath);
            return {
                instance: { id: instance.id, port: instance.port, status: instance.status },
                url: dshUrl(app.config.baseDomain, user),
            };
        }
        catch (err) {
            if (err instanceof AlreadyRunningError)
                return reply.code(409).send({ error: 'already_running' });
            throw err;
        }
    });
    app.post('/api/dsh/restart', { preHandler: requireAuth, schema: restartSchema }, async (request, reply) => {
        const { command } = request.body;
        const user = request.user;
        const handoffPath = join(app.config.dataRoot, 'users', user.id, 'handoff.json');
        mkdirSync(dirname(handoffPath), { recursive: true });
        writeFileSync(handoffPath, JSON.stringify({ command, createdAt: Date.now() }));
        const instance = await app.supervisor.restartMain(user.id);
        if (instance === undefined)
            return reply.code(404).send({ error: 'not_running' });
        await app.supervisor.spawnWatchdog(user.id);
        return {
            instance: { id: instance.id, port: instance.port, status: instance.status },
            url: dshUrl(app.config.baseDomain, user),
        };
    });
    app.post('/api/dsh/stop', { preHandler: requireAuth }, async (request) => {
        app.supervisor.stop(request.user.id);
        return { ok: true };
    });
    app.get('/api/dsh/status', { preHandler: requireAuth }, async (request) => {
        const { main, watchdog } = app.supervisor.status(request.user.id);
        return {
            running: alive(main?.status),
            instance: main
                ? { id: main.id, port: main.port, status: main.status, exitCode: main.exitCode, lastError: main.lastError }
                : null,
            watchdog: watchdog ? { id: watchdog.id, status: watchdog.status, exitCode: watchdog.exitCode } : null,
            url: dshUrl(app.config.baseDomain, request.user),
        };
    });
};
//# sourceMappingURL=dsh.js.map