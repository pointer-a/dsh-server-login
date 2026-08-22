// Account-level isolation spawn flow: in 'account' mode the orchestrator passes
// a deterministic uid to the setuid wrapper, and the child still runs through it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const fakeSetpriv = join(here, 'fake-setpriv.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-iso-'))

const app = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    isolationMode: 'account',
    baseUid: 50000,
    spawnAsUserCommand: [process.execPath, fakeSetpriv, '--uid', '{UID}'],
    dshCommand: [process.execPath, fakeDsh],
  }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

await app.db.createUser({
  id: 'u1',
  username: 'gina',
  passHash: await hashPassword('ginapass123'),
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
  let r = await json('/api/auth/login', { method: 'POST', body: { username: 'gina', password: 'ginapass123' } })
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('launch   ->', r.status)
  assert(r.status === 200, 'launch succeeds')

  let uid
  for (let i = 0; i < 20; i++) {
    try {
      uid = readFileSync(join(dataRoot, 'users', 'u1', 'ws', 'proj', 'setpriv-uid.txt'), 'utf8').trim()
      break
    } catch {
      // the wrapper hasn't written yet
    }
    await sleep(100)
  }
  const expected = (await app.db.findUserById('u1')).uid
  console.log('setuid   ->', uid, '(expected', expected + ')')
  assert(uid === String(expected), 'setuid wrapper received the DB-assigned uid')

  let proxyText
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(base + '/u/u1/dsh/hello', { headers: { cookie } })
      if (res.status === 200) {
        proxyText = await res.text()
        break
      }
    } catch {
      // retry until the child is listening
    }
    await sleep(100)
  }
  console.log('proxy    ->', proxyText !== undefined)
  assert(proxyText !== undefined && proxyText.includes('fake-dsh'), 'dsh runs through the setuid wrapper')

  console.log('OK: account-level isolation spawn flow passed')
} finally {
  await app.close()
  await sleep(300)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}
