/**
 * DSH launch / supervise routes + the reverse proxy to a running instance.
 * Launch resolves the requested folder against the caller's workspace, reads
 * the folder's enabled plugins, writes a cordis patch for them, and spawns one
 * main DSH; stop/status drive the supervisor.
 * @module dsh-server-login/web/routes/dsh
 */

import type { FastifyPluginAsync } from 'fastify'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireAuth } from '../middleware/authn.js'
import { resolveWithinRoot } from '../middleware/fs-guard.js'
import { ensureWorkspaceRoot, workspaceRoot } from '../../fs/workspace.js'
import { findWorkspaceByPath, getEnabledPluginIds } from '../../db/repo.js'
import { AlreadyRunningError } from '../../supervisor/orchestrator.js'
import { renderPatch } from '../../supervisor/patch.js'
import { registerDshProxy } from '../../supervisor/proxy.js'

const launchSchema = {
  body: {
    type: 'object',
    required: ['folder'],
    additionalProperties: false,
    properties: { folder: { type: 'string', maxLength: 512 } },
  },
} as const

export const dshRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/dsh/launch', { preHandler: requireAuth, schema: launchSchema }, async (request, reply) => {
    const { folder } = request.body as { folder: string }
    const user = request.user!
    const root = workspaceRoot(app.config, user.id)
    ensureWorkspaceRoot(root)
    let folderAbs: string
    try {
      folderAbs = resolveWithinRoot(root, folder)
    } catch {
      return reply.code(400).send({ error: 'bad_path' })
    }
    try {
      if (!statSync(folderAbs).isDirectory()) return reply.code(400).send({ error: 'not_a_folder' })
    } catch {
      return reply.code(404).send({ error: 'not_found' })
    }

    // Per-folder plugin selection → cordis patch.
    let patchPath: string | undefined
    const workspace = findWorkspaceByPath(app.db, user.id, folder)
    if (workspace !== undefined) {
      const enabled = getEnabledPluginIds(app.db, workspace.id)
      if (enabled.length > 0) {
        const patchesDir = join(app.config.dataRoot, 'users', user.id, 'patches')
        mkdirSync(patchesDir, { recursive: true })
        patchPath = join(patchesDir, `${workspace.id}.yml`)
        writeFileSync(patchPath, renderPatch(enabled))
      }
    }

    try {
      const instance = await app.supervisor.launch(user.id, folderAbs, patchPath)
      return {
        instance: { id: instance.id, port: instance.port, status: instance.status },
        url: `/u/${user.id}/dsh/`,
      }
    } catch (err) {
      if (err instanceof AlreadyRunningError) return reply.code(409).send({ error: 'already_running' })
      throw err
    }
  })

  app.post('/api/dsh/stop', { preHandler: requireAuth }, async (request) => {
    app.supervisor.stop(request.user!.id)
    return { ok: true }
  })

  app.get('/api/dsh/status', { preHandler: requireAuth }, async (request) => {
    const instance = app.supervisor.statusFor(request.user!.id)
    if (instance === undefined) return { running: false }
    return {
      running: true,
      instance: { id: instance.id, port: instance.port, status: instance.status, folder: instance.folder },
    }
  })

  await registerDshProxy(app)
}
