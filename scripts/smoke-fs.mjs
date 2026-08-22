// Desktop/FS flow: login, list (empty), mkdir (nested), upload, and isolation
// checks (path escape rejected, upload name sanitized, unauthenticated rejected).
// Uses a throwaway dataRoot + in-memory DB so each run is fully isolated.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-fs-'))
const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:', dataRoot }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

await app.db.createUser({
  id: 'u1',
  username: 'bob',
  passHash: await hashPassword('bobpass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
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

  r = await json('/api/desktop/tree')
  assert(r.status === 401, 'unauthenticated tree is rejected')

  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, 'login succeeds')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/desktop/tree', { cookie })
  console.log('tree (empty)    ->', r.status, r.body?.entries)
  assert(r.status === 200 && r.body.entries.length === 0, 'empty workspace lists zero entries')

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  console.log('mkdir proj      ->', r.status)
  assert(r.status === 200, 'mkdir succeeds')

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj/sub' } })
  console.log('mkdir proj/sub  ->', r.status)
  assert(r.status === 200, 'nested mkdir succeeds')

  r = await json('/api/fs/upload', {
    method: 'POST',
    cookie,
    body: { path: 'proj', name: 'hello.txt', data: Buffer.from('hi there').toString('base64') },
  })
  console.log('upload          ->', r.status)
  assert(r.status === 200, 'upload succeeds')

  r = await json('/api/desktop/tree?path=proj', { cookie })
  console.log('tree proj       ->', r.status, r.body?.entries?.map((e) => `${e.name}:${e.type}`))
  assert(r.status === 200 && r.body.entries.some((e) => e.name === 'hello.txt'), 'uploaded file is listed')

  // isolation: a `..` in the *path* is rejected outright
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: '../escape' } })
  console.log('mkdir ../escape ->', r.status)
  assert(r.status === 400, 'path escape is rejected')

  // isolation: a path component in the *name* is sanitized to its base name
  r = await json('/api/fs/upload', {
    method: 'POST',
    cookie,
    body: { path: '', name: '../../evil.txt', data: 'aGk=' },
  })
  console.log('upload ../../   ->', r.status, r.body?.name)
  assert(r.status === 200 && r.body?.name === 'evil.txt', 'upload name is sanitized to its base name')

  console.log('OK: desktop/fs flow + isolation checks passed')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
