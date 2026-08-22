// Admin account flow: approve → disable → enable (restore), plus guard rails.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-admin-'))
const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:', dataRoot }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

await app.db.createUser({
  id: 'admin',
  username: 'admin',
  passHash: await hashPassword('adminpass123'),
  role: 'admin',
  homeDir: join(dataRoot, 'users', 'admin', 'home'),
})
await app.db.createUser({
  id: 'bob',
  username: 'bob',
  passHash: await hashPassword('bobpass123'),
  role: 'pending',
  homeDir: join(dataRoot, 'users', 'bob', 'home'),
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

try {
  let r
  // Pending user cannot log in.
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 403 && r.body.error === 'pending_review', 'pending user blocked from login')

  // Admin login.
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  assert(r.status === 200, 'admin logs in')
  const cookie = r.setCookie.split(';')[0]

  // Approve bob.
  r = await json('/api/admin/users/bob/approve', { method: 'POST', cookie })
  assert(r.status === 200, 'approve succeeds')

  // Bob can now log in.
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, 'approved user logs in')

  // Disable bob.
  r = await json('/api/admin/users/bob/disable', { method: 'POST', cookie })
  assert(r.status === 200, 'disable succeeds')

  // Bob blocked again (role disabled + sessions cleared).
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 403 && r.body.error === 'disabled', 'disabled user blocked from login')

  // Enable (restore) bob.
  r = await json('/api/admin/users/bob/enable', { method: 'POST', cookie })
  assert(r.status === 200, 'enable succeeds')

  // Bob can log in again.
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, 'restored user logs in')

  // Guard rails.
  r = await json('/api/admin/users/bob/enable', { method: 'POST', cookie })
  assert(r.status === 409 && r.body.error === 'not_disabled', 'enable on non-disabled → 409')
  r = await json('/api/admin/users/admin/disable', { method: 'POST', cookie })
  assert(r.status === 409 && r.body.error === 'cannot_disable_admin', 'cannot disable admin')

  console.log('OK: admin approve/disable/enable flow passed')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
