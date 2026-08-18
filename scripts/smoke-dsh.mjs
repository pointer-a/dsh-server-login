// DSH launch/status/proxy/stop flow against a stand-in `dsh` (fake-dsh.mjs).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-dsh-'))

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, dshCommand: [process.execPath, fakeDsh] }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'carol',
  passHash: await hashPassword('carolpass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
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

try {
  let r
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(r.status === 200, 'login succeeds')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false, 'not running initially')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('launch  ->', r.status, r.body)
  assert(r.status === 200 && r.body.url, 'launch succeeds')
  const url = r.body.url

  r = await json('/api/dsh/status', { cookie })
  console.log('status  ->', r.status, r.body)
  assert(r.body.running === true, 'running after launch')

  // The child binds its port asynchronously; poll the proxy until it answers.
  let proxyText
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(base + url + 'hello', { headers: { cookie } })
      if (res.status === 200) {
        proxyText = await res.text()
        break
      }
    } catch {
      // connection refused until the child is listening — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log('proxy   ->', proxyText)
  assert(proxyText !== undefined && proxyText.includes('fake-dsh'), 'proxy reaches the child DSH')

  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  console.log('stop    ->', r.status)
  assert(r.status === 200, 'stop succeeds')

  await new Promise((resolve) => setTimeout(resolve, 100))
  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false, 'stopped after stop')

  console.log('OK: dsh launch/status/proxy/stop flow passed')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
