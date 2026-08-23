/**
 * The per-user file sidecar (docs/k8s.md §4.10).
 *
 * Runs inside the user's own Pod as the user's uid, so it *can* read and write
 * their `0700` directory — the thing the control plane (uid 65532, no volume)
 * cannot do. It serves exactly one user: the root is fixed at startup, and no
 * request carries a user id.
 *
 * **No authentication.** The boundary is the NetworkPolicy that lets only the
 * control plane reach port 8082, the same argument that lets the socat sidecar
 * bridge 8081 unauthenticated (docs/k8s.md §6.1 item 4). If that policy is ever
 * widened, this service needs a token check *first*.
 * @module dsh-server-login/web/file-service
 */

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { LocalUserFs } from '../fs/local-user-fs.js'
import { UserFsError } from '../fs/user-fs.js'

/** Port the sidecar binds; the per-user Service targets it directly. */
export const FILE_SERVICE_PORT = 8082

/** Env var carrying the single user root this sidecar serves. */
export const USER_ROOT_ENV = 'DSH_SERVER_LOGIN_USER_ROOT'

/** The sidecar serves one user, so the id crossing {@link UserFs} is a constant. */
const SOLE_USER = 'self'

const pathSchema = {
  body: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: { type: 'string', maxLength: 512 } },
  },
} as const

const entrySchema = {
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

const handoffSchema = {
  body: {
    type: 'object',
    required: ['content'],
    additionalProperties: false,
    properties: { content: { type: 'string', maxLength: 8192 } },
  },
} as const

/** Reply with the seam's own wire form so the client can rebuild the error. */
function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UserFsError) return reply.code(err.status).send({ error: err.code })
  throw err
}

/**
 * Build the sidecar's Fastify instance. Does not listen; the caller binds.
 * @param root - the user's data root inside the Pod.
 * @param options - `bodyLimit` must exceed the control plane's upload cap.
 */
export function buildFileService(root: string, options: { bodyLimit: number; logLevel: string }): FastifyInstance {
  const fs = new LocalUserFs(() => root)
  const app = Fastify({ logger: { level: options.logLevel }, bodyLimit: options.bodyLimit })

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/fs/tree', async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    try {
      return { entries: await fs.listDir(SOLE_USER, path) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get('/fs/stat', async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    try {
      return { isDirectory: await fs.isDirectory(SOLE_USER, path) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get('/fs/plugins', async () => ({ plugins: await fs.listInstalledPlugins(SOLE_USER) }))

  app.post('/fs/init', async () => {
    await fs.initUserRoot(SOLE_USER)
    return { ok: true }
  })

  app.post('/fs/mkdir', { schema: pathSchema }, async (request, reply) => {
    const { path } = request.body as { path: string }
    try {
      await fs.mkdir(SOLE_USER, path)
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post('/fs/create', { schema: entrySchema }, async (request, reply) => {
    const { path, name, type } = request.body as { path: string; name: string; type: 'file' | 'dir' }
    try {
      return { name: await fs.createEntry(SOLE_USER, path, name, type) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post('/fs/upload', { schema: uploadSchema }, async (request, reply) => {
    const { path, name, data } = request.body as { path: string; name: string; data: string }
    try {
      return { name: await fs.upload(SOLE_USER, path, name, Buffer.from(data, 'base64')) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post('/fs/handoff', { schema: handoffSchema }, async (request) => {
    const { content } = request.body as { content: string }
    await fs.writeHandoff(SOLE_USER, content)
    return { ok: true }
  })

  return app
}
