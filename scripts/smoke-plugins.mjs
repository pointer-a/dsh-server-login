// Per-folder plugin flow: list catalog, persist a selection, then launch and
// verify the selection is injected (patch file + --patch argv).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-plugins-'))

const app = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    dshCommand: [process.execPath, fakeDsh],
    enablePatch: true,
    availablePlugins: [
      { id: 'p1', name: 'Plugin One', description: 'first' },
      { id: 'p2', name: 'Plugin Two', description: 'second' },
    ],
  }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'dave',
  passHash: await hashPassword('davepass123'),
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
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/plugins?folder=proj', { cookie })
  console.log('catalog     ->', r.status, r.body?.plugins)
  assert(r.status === 200 && r.body.plugins.length === 2 && r.body.plugins.every((p) => !p.enabled), 'catalog listed, none enabled')

  r = await json('/api/plugins/select', {
    method: 'POST',
    cookie,
    body: { folder: 'proj', plugins: [{ id: 'p1', enabled: true }, { id: 'p2', enabled: false }, { id: 'nope', enabled: true }] },
  })
  console.log('select      ->', r.status)
  assert(r.status === 200, 'select succeeds')

  r = await json('/api/plugins?folder=proj', { cookie })
  console.log('selection   ->', r.status, r.body?.plugins?.map((p) => `${p.id}:${p.enabled}`))
  assert(r.body.plugins.find((p) => p.id === 'p1').enabled === true, 'p1 enabled')
  assert(r.body.plugins.find((p) => p.id === 'p2').enabled === false, 'p2 disabled')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('launch      ->', r.status)
  assert(r.status === 200, 'launch succeeds')

  // Patch file should mount the runtime plugin and enable p1 only.
  const patchesDir = join(dataRoot, 'users', 'u1', 'patches')
  const files = readdirSync(patchesDir)
  assert(files.length === 1, 'one patch file written')
  const patch = readFileSync(join(patchesDir, files[0]), 'utf8')
  console.log('patch       ->', JSON.stringify(patch))
  assert(patch.includes('dsh-server-login/runtime'), 'patch mounts the runtime plugin')
  assert(patch.includes('p1') && !patch.includes('p2'), 'patch enables p1 only')

  // Proxy: the child's argv should include --patch.
  let proxyText
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(base + `/u/u1/dsh/hello`, { headers: { cookie } })
      if (res.status === 200) {
        proxyText = await res.text()
        break
      }
    } catch {
      // retry until the child is listening
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log('proxy       ->', proxyText)
  assert(proxyText !== undefined && proxyText.includes('--patch'), 'child received --patch')

  console.log('OK: per-folder plugin flow passed')
} finally {
  await app.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup: a child may still hold the dir on Windows
  }
}
