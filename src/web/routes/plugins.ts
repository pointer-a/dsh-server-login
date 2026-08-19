/**
 * Plugin listing / per-folder selection routes. The catalog is discovered
 * per-user from the resident DSH profile; selections are persisted to
 * `folder_plugins` (keyed by the folder workspace) and injected into the child
 * DSH at launch.
 * @module dsh-server-login/web/routes/plugins
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAuth } from '../middleware/authn.js'
import { resolveWithinRoot } from '../middleware/fs-guard.js'
import { listInstalledPlugins } from '../../fs/plugins.js'
import { ensureWorkspaceRoot, workspaceRoot } from '../../fs/workspace.js'
import { findWorkspaceByPath, getEnabledPluginIds, getOrCreateWorkspace, setFolderPlugins } from '../../db/repo.js'

const selectSchema = {
  body: {
    type: 'object',
    required: ['folder', 'plugins'],
    additionalProperties: false,
    properties: {
      folder: { type: 'string', maxLength: 512 },
      plugins: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'enabled'],
          additionalProperties: false,
          properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
        },
      },
    },
  },
} as const

interface Selection {
  id: string
  enabled: boolean
}

export const pluginRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/plugins', { preHandler: requireAuth }, async (request, reply) => {
    const { folder = '' } = request.query as { folder?: string }
    const user = request.user!
    const root = workspaceRoot(app.config, user.id)
    ensureWorkspaceRoot(root)
    try {
      resolveWithinRoot(root, folder)
    } catch {
      return reply.code(400).send({ error: 'bad_path' })
    }
    const workspace = findWorkspaceByPath(app.db, user.id, folder)
    const enabled = workspace === undefined ? [] : getEnabledPluginIds(app.db, workspace.id)
    return {
      plugins: listInstalledPlugins(app.config, user.id).map((plugin) => ({ ...plugin, enabled: enabled.includes(plugin.id) })),
    }
  })

  app.post('/api/plugins/select', { preHandler: requireAuth, schema: selectSchema }, async (request, reply) => {
    const { folder, plugins } = request.body as { folder: string; plugins: Selection[] }
    const user = request.user!
    const root = workspaceRoot(app.config, user.id)
    ensureWorkspaceRoot(root)
    try {
      resolveWithinRoot(root, folder)
    } catch {
      return reply.code(400).send({ error: 'bad_path' })
    }
    // Allowlist: only persist ids the user actually has installed.
    const catalogIds = new Set(listInstalledPlugins(app.config, user.id).map((plugin) => plugin.id))
    const filtered = plugins.filter((plugin) => catalogIds.has(plugin.id))
    const workspace = getOrCreateWorkspace(app.db, user.id, folder)
    setFolderPlugins(app.db, workspace.id, filtered)
    return { ok: true }
  })
}
