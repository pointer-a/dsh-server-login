/**
 * Plugin listing / per-folder selection routes. The catalog is discovered
 * per-user from the resident DSH profile; selections are persisted to
 * `folder_plugins` (keyed by the folder workspace) and injected into the child
 * DSH at launch.
 * @module dsh-server-login/web/routes/plugins
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAuth } from '../middleware/authn.js'
import { sendFsError } from './desktop.js'

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
    const fs = app.userFs
    let installed
    try {
      fs.resolvePath(user.id, folder) // reject traversal before any DB work
      installed = await fs.listInstalledPlugins(user.id)
    } catch (err) {
      return sendFsError(reply, err)
    }
    const workspace = await app.db.findWorkspaceByPath(user.id, folder)
    const enabled = workspace === undefined ? [] : await app.db.getEnabledPluginIds(workspace.id)
    return {
      plugins: installed.map((plugin) => ({ ...plugin, enabled: enabled.includes(plugin.id) })),
    }
  })

  app.post('/api/plugins/select', { preHandler: requireAuth, schema: selectSchema }, async (request, reply) => {
    const { folder, plugins } = request.body as { folder: string; plugins: Selection[] }
    const user = request.user!
    const fs = app.userFs
    // Allowlist: only persist ids the user actually has installed.
    let catalogIds: Set<string>
    try {
      fs.resolvePath(user.id, folder)
      catalogIds = new Set((await fs.listInstalledPlugins(user.id)).map((plugin) => plugin.id))
    } catch (err) {
      return sendFsError(reply, err)
    }
    const filtered = plugins.filter((plugin) => catalogIds.has(plugin.id))
    const workspace = await app.db.getOrCreateWorkspace(user.id, folder)
    await app.db.setFolderPlugins(workspace.id, filtered)
    return { ok: true }
  })
}
