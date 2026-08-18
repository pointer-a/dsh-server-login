/**
 * Reverse proxy from the orchestrator to a running per-user DSH web UI.
 *
 * P3 proxies plain HTTP. WebSocket upgrade and absolute-path/Location rewriting
 * are deferred (see docs/blueprint.md §1b) — nginx in P6 is the intended
 * termination point for those.
 * @module dsh-server-login/supervisor/proxy
 */

import type { FastifyInstance } from 'fastify'
import { request as httpRequest } from 'node:http'
import { requireAuth } from '../web/middleware/authn.js'

/**
 * Register the authenticated `/u/:slug/dsh/*` proxy. The `:slug` is the user id;
 * a caller can only proxy their own instance.
 */
export async function registerDshProxy(app: FastifyInstance): Promise<void> {
  app.all('/u/:slug/dsh/*', { preHandler: requireAuth }, (request, reply) => {
    const slug = (request.params as { slug: string }).slug
    if (request.user === null || request.user.id !== slug) {
      reply.code(403).send({ error: 'forbidden' })
      return
    }
    const port = app.supervisor.portFor(slug)
    if (port === undefined) {
      reply.code(404).send({ error: 'not_running' })
      return
    }

    const prefix = `/u/${slug}/dsh`
    const rawUrl = request.raw.url ?? '/'
    const targetPath = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) || '/' : rawUrl

    reply.hijack()
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: targetPath,
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${port}` },
      },
      (upRes) => {
        reply.raw.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(reply.raw)
      },
    )
    upstream.on('error', () => reply.raw.destroy())
    request.raw.pipe(upstream)
  })
}
