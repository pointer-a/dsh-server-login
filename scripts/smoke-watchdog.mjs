// Watchdog / crash-takeover flow: launch spawns main+watchdog, a planned
// restart hands off a post-restart command that the watchdog executes, and a
// crashed main is auto-restarted by the supervisor.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-watchdog-'))

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, dshCommand: [process.execPath, fakeDsh], restartBackoffMs: 100 }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'eve',
  passHash: await hashPassword('evepass123'),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  let r
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'eve', password: 'evepass123' } })
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('launch   ->', r.status)
  assert(r.status === 200, 'launch succeeds')
  const firstMainId = r.body.instance.id

  r = await json('/api/dsh/status', { cookie })
  console.log('status   -> main:', r.body.instance?.status, 'watchdog:', r.body.watchdog?.status)
  assert(r.body.watchdog?.status === 'running', 'watchdog spawned alongside main')

  // Planned restart with a post-restart command.
  r = await json('/api/dsh/restart', { method: 'POST', cookie, body: { command: 'reinstall p1' } })
  console.log('restart  ->', r.status, r.body?.instance?.id !== firstMainId ? 'new main' : 'SAME')
  assert(r.status === 200 && r.body.instance.id !== firstMainId, 'restart spawns a new main')

  const executedPath = join(dataRoot, 'users', 'u1', 'watchdog-executed.json')
  let executed
  for (let i = 0; i < 30; i++) {
    try {
      executed = JSON.parse(readFileSync(executedPath, 'utf8'))
      break
    } catch {
      // watchdog hasn't picked up the handoff yet
    }
    await sleep(100)
  }
  console.log('executed ->', executed)
  assert(executed?.command === 'reinstall p1', 'watchdog executed the post-restart command')

  // Crash the main; the supervisor should auto-restart it.
  await fetch(base + '/u/u1/dsh/crash', { headers: { cookie } }).catch(() => {})
  let restarted
  for (let i = 0; i < 30; i++) {
    const status = await json('/api/dsh/status', { cookie })
    if (status.body.instance && status.body.instance.status === 'running' && status.body.instance.id !== r.body.instance.id) {
      restarted = status.body.instance
      break
    }
    await sleep(100)
  }
  console.log('restarted->', restarted?.status, restarted?.id)
  assert(restarted !== undefined, 'main auto-restarted after crash')

  r = await json('/api/dsh/status', { cookie })
  assert(r.body.watchdog?.status === 'running', 'watchdog still running after crash')

  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  assert(r.status === 200, 'stop succeeds')

  console.log('OK: watchdog/crash-takeover flow passed')
} finally {
  await app.close()
  await sleep(300)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}
