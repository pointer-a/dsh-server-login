/**
 * Reverse proxy from the orchestrator to a running per-user DSH.
 *
 * Two entry points:
 * - subpath `/u/:slug/dsh/*` (authenticated, legacy), and
 * - per-user subdomain `<username>.<baseDomain>` (HTTP + WebSocket). The DSH's
 *   absolute-path SPA requires the subdomain form: its `/assets/*` and `/api/*`
 *   resolve against the host root, which only works when each DSH owns a host.
 * @module dsh-server-login/supervisor/proxy
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { findUserBySlug } from '../db/repo.js'
import { requireAuth } from '../web/middleware/authn.js'

const upstreamAgent = new Agent({ keepAlive: true, maxSockets: 32 })

/** Extract `<slug>` from `<slug>.<baseDomain>`, or null when not a match. */
export function parseSubdomain(host: string | undefined, baseDomain: string): string | null {
  if (host === undefined || baseDomain === '') return null
  const name = host.split(':')[0] ?? ''
  if (name === baseDomain) return null
  if (name.endsWith('.' + baseDomain)) {
    const slug = name.slice(0, -(baseDomain.length + 1))
    return slug !== '' ? slug.toLowerCase() : null
  }
  return null
}

/** The per-user subdomain for a username, or null when `baseDomain` is unset. */
export function subdomainForUser(baseDomain: string, username: string): string | null {
  return baseDomain === '' ? null : `${username.toLowerCase()}.${baseDomain}`
}

/** Resolve a Host header to a running DSH loopback port, or undefined. */
function resolvePort(app: FastifyInstance, host: string | undefined): number | undefined {
  const slug = parseSubdomain(host, app.config.baseDomain)
  if (slug === null) return undefined
  const user = findUserBySlug(app.db, slug)
  if (user === undefined) return undefined
  return app.supervisor.portFor(user.id)
}

function proxyHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  port: number,
  targetPath: string,
  rewritePrefix?: string,
): void {
  reply.hijack()
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: targetPath,
      method: request.method,
      agent: upstreamAgent,
      headers: { ...request.headers, host: `127.0.0.1:${port}` },
    },
    (upRes: IncomingMessage) => {
      const headers = { ...upRes.headers }
      const location = upRes.headers.location
      if (
        rewritePrefix !== undefined &&
        typeof location === 'string' &&
        location.startsWith('/') &&
        !location.startsWith('//') &&
        !location.startsWith(rewritePrefix)
      ) {
        headers.location = rewritePrefix + location
      }
      reply.raw.writeHead(upRes.statusCode ?? 502, headers)
      upRes.pipe(reply.raw)
    },
  )
  upstream.on('error', () => reply.raw.destroy())
  request.raw.pipe(upstream)
}

export async function registerDshProxy(app: FastifyInstance): Promise<void> {
  // Legacy authenticated subpath proxy.
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
    proxyHttp(request, reply, port, targetPath, prefix)
  })

  // Per-user subdomain: HTTP (intercept before normal routing).
  app.addHook('onRequest', async (request, reply) => {
    const port = resolvePort(app, request.headers.host)
    if (port === undefined) return
    proxyHttp(request, reply, port, request.raw.url ?? '/')
  })

  // Per-user subdomain: WebSocket upgrade tunnel.
  app.server.on('upgrade', (req, socket, head) => {
    const port = resolvePort(app, req.headers.host)
    if (port === undefined) {
      socket.destroy()
      return
    }
    const upstream = connect({ host: '127.0.0.1', port })
    upstream.on('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head !== undefined && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
}
