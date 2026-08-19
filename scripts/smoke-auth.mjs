// End-to-end auth + review flow: seed an admin, register a user, verify they
// cannot log in while pending, approve them, then verify login + /me.
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:' }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

// Seed the first admin directly (what `bootstrap-admin` does).
createUser(app.db, {
  id: 'admin-1',
  username: 'admin',
  passHash: await hashPassword('adminpass123'),
  role: 'admin',
  homeDir: '/tmp/admin-home',
})

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

const sid = (setCookie) => (setCookie ? setCookie.split(';')[0] : undefined)

let r

r = await json('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'alicepass123' } })
console.log('register alice          ->', r.status)
assert(r.status === 201, 'register creates a pending user')

r = await json('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alicepass123' } })
console.log('login alice (pending)   ->', r.status, r.body?.error)
assert(r.status === 403 && r.body?.error === 'pending_review', 'pending user is refused login')

r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
console.log('login admin             ->', r.status)
assert(r.status === 200, 'admin login succeeds')
const adminCookie = sid(r.setCookie)

r = await json('/api/admin/users', { cookie: adminCookie })
console.log('list users              ->', r.status, r.body?.users?.map((u) => `${u.username}:${u.role}`))
assert(r.status === 200, 'admin can list users')
const alice = r.body.users.find((u) => u.username === 'alice')
assert(alice?.role === 'pending', 'alice listed as pending')

r = await json(`/api/admin/users/${alice.id}/approve`, { method: 'POST', cookie: adminCookie })
console.log('approve alice           ->', r.status)
assert(r.status === 200, 'approve succeeds')

r = await json('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alicepass123' } })
console.log('login alice (approved)  ->', r.status, r.body?.user)
assert(r.status === 200 && r.body.user.role === 'active', 'approved user logs in')
const aliceCookie = sid(r.setCookie)

r = await json('/api/auth/me', { cookie: aliceCookie })
console.log('me (alice)              ->', r.status, r.body?.user)
assert(r.status === 200 && r.body.user.username === 'alice', '/me returns the current user')

r = await json('/api/me/key', { cookie: aliceCookie })
console.log('key (none)              ->', r.status, r.body)
assert(r.body?.hasKey === false, 'no key initially')

r = await json('/api/me/key', { method: 'PUT', cookie: aliceCookie, body: { apiKey: 'sk-good1-abc' } })
console.log('key (set)               ->', r.status)
assert(r.status === 200, 'key is stored')

r = await json('/api/me/key', { cookie: aliceCookie })
assert(r.body?.hasKey === true, 'hasKey true after setting')

r = await json('/api/me/key', { method: 'PUT', cookie: aliceCookie, body: { apiKey: 'bad key with space' } })
console.log('key (bad charset)       ->', r.status)
assert(r.status === 400, 'header-hostile key is rejected')

await app.close()
console.log('OK: full auth + review + per-user key flow passed')
