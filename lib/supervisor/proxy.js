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
import { Agent, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { findSessionWithUser, findUserBySlug } from '../db/repo.js';
import { hashSessionToken, parseCookie } from '../web/auth.js';
import { requireAuth } from '../web/middleware/authn.js';
const upstreamAgent = new Agent({ keepAlive: true, maxSockets: 32 });
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
]);
function buildUpstreamHeaders(headers, port) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || STRIP_HEADERS.has(key.toLowerCase()))
            continue;
        out[key] = value;
    }
    out.host = `127.0.0.1:${port}`;
    return out;
}
/** Extract `<slug>` from `<slug>.<baseDomain>`, or null when not a match. */
export function parseSubdomain(host, baseDomain) {
    if (host === undefined || baseDomain === '')
        return null;
    const name = host.split(':')[0] ?? '';
    if (name === baseDomain)
        return null;
    if (name.endsWith('.' + baseDomain)) {
        const slug = name.slice(0, -(baseDomain.length + 1));
        return slug !== '' ? slug.toLowerCase() : null;
    }
    return null;
}
/** The per-user subdomain for a username, or null when `baseDomain` is unset. */
export function subdomainForUser(baseDomain, username) {
    return baseDomain === '' ? null : `${username.toLowerCase()}.${baseDomain}`;
}
/**
 * Resolve a subdomain Host to a DSH port, authenticating the caller: the session
 * cookie must belong to a non-disabled user whose username matches the subdomain.
 */
function resolveSubdomainAccess(app, host, cookieHeader) {
    const slug = parseSubdomain(host, app.config.baseDomain);
    if (slug === null)
        return null;
    const target = findUserBySlug(app.db, slug);
    if (target === undefined)
        return { error: 'unknown_user', code: 404 };
    const token = parseCookie(cookieHeader, 'sid');
    const session = token === undefined ? undefined : findSessionWithUser(app.db, hashSessionToken(token));
    if (session === undefined || session.expiresAt <= Date.now() || session.user.role === 'disabled') {
        return { error: 'unauthorized', code: 401 };
    }
    if (session.user.username.toLowerCase() !== slug) {
        return { error: 'forbidden', code: 403 };
    }
    const port = app.supervisor.portFor(session.user.id);
    if (port === undefined)
        return { error: 'not_running', code: 404 };
    return { port };
}
function proxyHttp(request, reply, port, targetPath, rewritePrefix) {
    reply.hijack();
    const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        path: targetPath,
        method: request.method,
        agent: upstreamAgent,
        headers: buildUpstreamHeaders(request.headers, port),
    }, (upRes) => {
        const headers = { ...upRes.headers };
        const location = upRes.headers.location;
        if (rewritePrefix !== undefined &&
            typeof location === 'string' &&
            location.startsWith('/') &&
            !location.startsWith('//') &&
            !location.startsWith(rewritePrefix)) {
            headers.location = rewritePrefix + location;
        }
        reply.raw.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(reply.raw);
    });
    upstream.on('error', () => reply.raw.destroy());
    request.raw.pipe(upstream);
}
export async function registerDshProxy(app) {
    // Legacy authenticated subpath proxy.
    app.all('/u/:slug/dsh/*', { preHandler: requireAuth }, (request, reply) => {
        const slug = request.params.slug;
        if (request.user === null || request.user.id !== slug) {
            reply.code(403).send({ error: 'forbidden' });
            return;
        }
        const port = app.supervisor.portFor(slug);
        if (port === undefined) {
            reply.code(404).send({ error: 'not_running' });
            return;
        }
        const prefix = `/u/${slug}/dsh`;
        const rawUrl = request.raw.url ?? '/';
        const targetPath = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) || '/' : rawUrl;
        proxyHttp(request, reply, port, targetPath, prefix);
    });
    // Per-user subdomain: HTTP (intercept before normal routing).
    app.addHook('onRequest', async (request, reply) => {
        const access = resolveSubdomainAccess(app, request.headers.host, request.headers.cookie);
        if (access === null)
            return;
        if ('error' in access) {
            reply.code(access.code).send({ error: access.error });
            return;
        }
        proxyHttp(request, reply, access.port, request.raw.url ?? '/');
    });
    // Per-user subdomain: WebSocket upgrade tunnel.
    app.server.on('upgrade', (req, socket, head) => {
        const access = resolveSubdomainAccess(app, req.headers.host, req.headers.cookie);
        if (access === null || 'error' in access) {
            socket.destroy();
            return;
        }
        const upstream = connect({ host: '127.0.0.1', port: access.port });
        upstream.on('connect', () => {
            const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = (req.rawHeaders[i] ?? '').toLowerCase();
                if (name === 'host' || STRIP_HEADERS.has(name))
                    continue;
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            lines.push(`Host: 127.0.0.1:${access.port}`);
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            if (head !== undefined && head.length > 0)
                upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });
}
//# sourceMappingURL=proxy.js.map