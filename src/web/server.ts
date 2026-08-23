/**
 * Fastify bootstrap: assembles the HTTP server, registers plugins and routes,
 * and owns the DB lifecycle via the close hook.
 * @module dsh-server-login/web/server
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { createDbAdapter, type DbAdapter, type PublicUser } from '../db/index.js'
import { decrypt, deriveKey } from '../crypto.js'
import { hashUid } from '../isolation.js'
import { LocalSpawner } from '../supervisor/orchestrator.js'
import { K8sSpawner } from '../supervisor/k8s-spawner.js'
import { registerDshProxy } from '../supervisor/proxy.js'
import type { Spawner } from '../supervisor/spawner.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { desktopRoutes } from './routes/desktop.js'
import { dshRoutes } from './routes/dsh.js'
import { pluginRoutes } from './routes/plugins.js'
import { domainRoutes } from './routes/domain.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DbAdapter
    config: ServerConfig
    supervisor: Spawner
  }
  interface FastifyRequest {
    user: PublicUser | null
  }
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web')

/**
 * Build a fully-wired Fastify instance. Does not call `listen`; the caller owns
 * bind + shutdown.
 * @param config - resolved runtime configuration.
 */
export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const db = await createDbAdapter(config)
  const encryptionKey = deriveKey(config.encryptionSecret)
  const resolveApiKey = async (userId: string): Promise<string | null> => {
    const ref = await db.getEnabledCredentialKeyRef(userId)
    if (ref === null) return null
    try {
      return decrypt(ref, encryptionKey)
    } catch {
      return null // corrupt ref — treat as unset, let the user re-enter it
    }
  }
  const resolveUid = async (userId: string): Promise<number> => {
    const user = await db.findUserById(userId)
    return user?.uid ?? hashUid(userId, config.baseUid)
  }
  const supervisor: Spawner =
    config.deployMode === 'k8s'
      ? new K8sSpawner(config, resolveApiKey, resolveUid)
      : new LocalSpawner(config, resolveApiKey, resolveUid)

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: config.maxUploadBytes,
  })

  app.decorate('db', db)
  app.decorate('config', config)
  app.decorate('supervisor', supervisor)
  app.decorateRequest('user', null)

  // Reverse proxy (subdomain + legacy subpath). Registered first so its global
  // onRequest hook intercepts per-user subdomain traffic before other hooks.
  await registerDshProxy(app)

  app.addHook('onClose', async () => {
    await supervisor.teardown()
    await db.close()
  })

  // Rate limiting first so auth/admin surfaces are covered by default.
  await app.register(rateLimit)

  // Domain-specific route groups (API).
  await app.register(authRoutes)
  await app.register(adminRoutes)
  await app.register(desktopRoutes)
  await app.register(dshRoutes)
  await app.register(pluginRoutes)
  await app.register(domainRoutes)

  // Static placeholder SPA last, so exact API routes take precedence over the
  // wildcard static handler.
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
  })

  return app
}
