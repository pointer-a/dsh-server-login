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
import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { hashSessionToken, parseCookie } from '../web/auth.js'
import { requireAuth } from '../web/middleware/authn.js'
import type { Endpoint } from './spawner.js'

const upstreamAgent = new Agent({ keepAlive: true, maxSockets: 32 })

// Headers the DSH's browser-trust fence must NOT see from the browser, so the
// proxied request looks like a clean loopback client (its Host is overridden to
// loopback; a mismatched Origin would otherwise 403).
const STRIP_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
])

function buildUpstreamHeaders(headers: IncomingHttpHeaders, port: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || STRIP_HEADERS.has(key.toLowerCase())) continue
    out[key] = value as string | string[]
  }
  out.host = `127.0.0.1:${port}`
  return out
}

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

/** A subdomain resolution: a tunnelable endpoint, an error to return, or null (not a subdomain). */
type SubdomainAccess = { endpoint: Endpoint } | { error: string; code: number } | null

/**
 * Resolve a subdomain Host to a DSH port, authenticating the caller: the session
 * cookie must belong to a non-disabled user whose username matches the subdomain.
 */
async function resolveSubdomainAccess(
  app: FastifyInstance,
  host: string | undefined,
  cookieHeader: string | undefined,
): Promise<SubdomainAccess> {
  const slug = parseSubdomain(host, app.config.baseDomain)
  if (slug === null) return null
  const target = await app.db.findUserBySlug(slug)
  if (target === undefined) return { error: 'unknown_user', code: 404 }
  const token = parseCookie(cookieHeader, 'sid')
  const session = token === undefined ? undefined : await app.db.findSessionWithUser(hashSessionToken(token))
  if (session === undefined || session.expiresAt <= Date.now() || session.user.role === 'disabled') {
    return { error: 'unauthorized', code: 401 }
  }
  if (session.user.username.toLowerCase() !== slug) {
    return { error: 'forbidden', code: 403 }
  }
  const endpoint = await app.supervisor.endpointFor(session.user.id)
  if (endpoint === undefined) return { error: 'not_running', code: 404 }
  return { endpoint }
}

function proxyHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: Endpoint,
  targetPath: string,
  rewritePrefix?: string,
): void {
  reply.hijack()
  const upstream = httpRequest(
    {
      host: endpoint.host,
      port: endpoint.port,
      path: targetPath,
      method: request.method,
      agent: upstreamAgent,
      // Host header stays loopback for the DSH trust fence; the TCP target host
      // is endpoint.host above. k8s mode overrides the header port separately.
      headers: buildUpstreamHeaders(request.headers, endpoint.port),
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
  app.all('/u/:slug/dsh/*', { preHandler: requireAuth }, async (request, reply) => {
    const slug = (request.params as { slug: string }).slug
    if (request.user === null || request.user.id !== slug) {
      reply.code(403).send({ error: 'forbidden' })
      return
    }
    const endpoint = await app.supervisor.endpointFor(slug)
    if (endpoint === undefined) {
      reply.code(404).send({ error: 'not_running' })
      return
    }
    const prefix = `/u/${slug}/dsh`
    const rawUrl = request.raw.url ?? '/'
    const targetPath = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) || '/' : rawUrl
    proxyHttp(request, reply, endpoint, targetPath, prefix)
  })

  // Per-user subdomain: HTTP (intercept before normal routing).
  app.addHook('onRequest', async (request, reply) => {
    const access = await resolveSubdomainAccess(app, request.headers.host, request.headers.cookie)
    if (access === null) return
    if ('error' in access) {
      reply.code(access.code).send({ error: access.error })
      return
    }
    proxyHttp(request, reply, access.endpoint, request.raw.url ?? '/')
  })

  // Per-user subdomain: WebSocket upgrade tunnel. Auth is async (DB lookup), so
  // the raw `upgrade` callback defers to an async IIFE before deciding to tunnel.
  app.server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const access = await resolveSubdomainAccess(app, req.headers.host, req.headers.cookie)
      if (access === null || 'error' in access) {
        socket.destroy()
        return
      }
      const upstream = connect({ host: access.endpoint.host, port: access.endpoint.port })
      upstream.on('connect', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = (req.rawHeaders[i] ?? '').toLowerCase()
          if (name === 'host' || STRIP_HEADERS.has(name)) continue
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
        lines.push(`Host: 127.0.0.1:${access.endpoint.port}`)
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head !== undefined && head.length > 0) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })()
  })
}
