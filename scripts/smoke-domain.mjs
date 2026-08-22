// Domain + nginx + proxy-rewrite flow: set/get a custom domain, regenerate its
// nginx config, admin verification, and the proxy rewriting Location redirects
// under the /u/<id>/dsh subpath.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-domain-'))

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, dshCommand: [process.execPath, fakeDsh] }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

await app.db.createUser({
  id: 'u1',
  username: 'frank',
  passHash: await hashPassword('frankpass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
await app.db.createUser({
  id: 'admin',
  username: 'admin',
  passHash: await hashPassword('adminpass123'),
  role: 'admin',
  homeDir: '/tmp/admin-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

async function json(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  let r
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'frank', password: 'frankpass123' } })
  const cookie = r.setCookie.split(';')[0]
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  const adminCookie = r.setCookie.split(';')[0]

  r = await json('/api/domain', { cookie })
  console.log('domain (empty) ->', r.status, r.body)
  assert(r.status === 200 && r.body.domain === null, 'no domain initially')

  r = await json('/api/domain', { method: 'PUT', cookie, body: { domain: 'http://bad' } })
  console.log('put invalid    ->', r.status)
  assert(r.status === 400, 'invalid domain rejected')

  r = await json('/api/domain', { method: 'PUT', cookie, body: { domain: 'ALICE.Example.com' } })
  console.log('put domain     ->', r.status, r.body?.domain)
  assert(r.status === 200 && r.body.domain === 'alice.example.com', 'domain normalized + stored')
  assert(r.body.nginx_config.includes('server_name alice.example.com'), 'config has server_name')
  assert(r.body.nginx_config.includes('/u/u1/dsh/'), 'config rewrites to user subpath')

  r = await json('/api/domain', { cookie })
  console.log('domain (get)   ->', r.status, r.body?.domain, 'verified:', r.body?.verified)
  assert(r.body.domain === 'alice.example.com' && r.body.verified === false, 'domain retrieved, unverified')

  r = await json('/api/nginx/regen', { method: 'POST', cookie })
  console.log('regen          ->', r.status)
  assert(r.status === 200 && r.body.nginx_config.includes('server_name alice.example.com'), 'regen returns config')

  r = await json('/api/admin/domains', { cookie: adminCookie })
  console.log('admin list     ->', r.status, r.body?.domains?.map((d) => `${d.domain}:${d.verified}`))
  const dom = r.body.domains.find((d) => d.domain === 'alice.example.com')
  assert(dom && dom.verified === false, 'admin lists unverified domain')

  r = await json(`/api/admin/domains/${dom.id}/verify`, { method: 'POST', cookie: adminCookie })
  console.log('verify         ->', r.status)
  assert(r.status === 200, 'admin verifies domain')

  r = await json('/api/admin/domains', { cookie: adminCookie })
  assert(r.body.domains.find((d) => d.domain === 'alice.example.com').verified === true, 'domain now verified')

  // Proxy Location rewrite.
  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  assert(r.status === 200, 'launch succeeds')
  let location
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(base + '/u/u1/dsh/redirect', { headers: { cookie }, redirect: 'manual' })
      if (res.status === 302) {
        location = res.headers.get('location')
        break
      }
    } catch {
      // retry until the child is listening
    }
    await sleep(100)
  }
  console.log('proxy redirect ->', location)
  assert(location === '/u/u1/dsh/somewhere', 'Location rewritten under subpath')

  console.log('OK: domain + nginx + proxy-rewrite flow passed')
} finally {
  await app.close()
  await sleep(300)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}
