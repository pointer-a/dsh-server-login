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
import { openDatabase, type Database } from '../db/connection.js'
import { getEnabledCredentialKeyRef, type PublicUser } from '../db/repo.js'
import { decrypt, deriveKey } from '../crypto.js'
import { Supervisor } from '../supervisor/orchestrator.js'
import { registerDshProxy } from '../supervisor/proxy.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { desktopRoutes } from './routes/desktop.js'
import { dshRoutes } from './routes/dsh.js'
import { pluginRoutes } from './routes/plugins.js'
import { domainRoutes } from './routes/domain.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Database
    config: ServerConfig
    supervisor: Supervisor
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
  const db = openDatabase(config.dbPath)
  const encryptionKey = deriveKey(config.encryptionSecret)
  const supervisor = new Supervisor(config, (userId) => {
    const ref = getEnabledCredentialKeyRef(db, userId)
    if (ref === null) return null
    try {
      return decrypt(ref, encryptionKey)
    } catch {
      return null // corrupt ref — treat as unset, let the user re-enter it
    }
  })

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
    supervisor.teardown()
    db.close()
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
