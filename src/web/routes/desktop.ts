/**
 * Desktop / filesystem routes: list the user's workspace, create a folder, and
 * upload a file. Every path is resolved against the caller's own workspace
 * root, so one user can never address another user's files.
 *
 * The routes never touch `node:fs` themselves — they go through the
 * {@link UserFs} seam, which is in-process under `local` and a per-user file
 * sidecar under `k8s` (docs/k8s.md §4.10).
 * @module dsh-server-login/web/routes/desktop
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { requireAuth } from '../middleware/authn.js'
import { UserFsError } from '../../fs/user-fs.js'

const mkdirSchema = {
  body: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: { type: 'string', maxLength: 512 } },
  },
} as const

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
} as const

const createSchema = {
  body: {
    type: 'object',
    required: ['path', 'name', 'type'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', maxLength: 512 },
      name: { type: 'string', maxLength: 255 },
      type: { type: 'string', enum: ['file', 'dir'] },
    },
  },
} as const

/** Turn a seam failure into the `{error}` body the desktop UI switches on. */
export function sendFsError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UserFsError) return reply.code(err.status).send({ error: err.code })
  throw err
}

export const desktopRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/desktop/tree', { preHandler: requireAuth }, async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    try {
      return { path, entries: await app.userFs.listDir(request.user!.id, path) }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post('/api/fs/mkdir', { preHandler: requireAuth, schema: mkdirSchema }, async (request, reply) => {
    const { path } = request.body as { path: string }
    try {
      await app.userFs.mkdir(request.user!.id, path)
      return { ok: true }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post('/api/fs/upload', { preHandler: requireAuth, schema: uploadSchema }, async (request, reply) => {
    const { path, name, data } = request.body as { path: string; name: string; data: string }
    let buf: Buffer
    try {
      buf = Buffer.from(data, 'base64')
    } catch {
      return reply.code(400).send({ error: 'bad_data' })
    }
    try {
      return { ok: true, name: await app.userFs.upload(request.user!.id, path, name, buf) }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post('/api/fs/create', { preHandler: requireAuth, schema: createSchema }, async (request, reply) => {
    const { path, name, type } = request.body as { path: string; name: string; type: 'file' | 'dir' }
    try {
      return { ok: true, name: await app.userFs.createEntry(request.user!.id, path, name, type), type }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })
}
