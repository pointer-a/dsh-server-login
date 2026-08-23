// File sidecar round-trip: drive K8sUserFs against a real buildFileService
// instance and assert it behaves identically to LocalUserFs on the same volume.
// This is the k8s desktop-FS path (docs/k8s.md §4.10) exercised without a
// cluster: the sidecar is bound on loopback and the client's Service-DNS
// resolution is stubbed to point at it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFileService } from '../lib/web/file-service.js'
import { K8sUserFs } from '../lib/fs/k8s-user-fs.js'
import { LocalUserFs } from '../lib/fs/local-user-fs.js'
import { UserFsError } from '../lib/fs/user-fs.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

async function rejectsWith(fn, code, message) {
  try {
    await fn()
  } catch (err) {
    assert(err instanceof UserFsError, `${message} (got ${err})`)
    assert(err.code === code, `${message} (got ${err.code})`)
    return
  }
  throw new Error('ASSERT: ' + message + ' (resolved instead)')
}

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-sidecar-'))
const userRoot = join(dataRoot, 'users', 'u1')

// The sidecar serves exactly this one user's root, as its Pod would.
const sidecar = buildFileService(userRoot, { bodyLimit: 8 * 1024 * 1024, logLevel: 'warn' })
await sidecar.listen({ host: '127.0.0.1', port: 0 })
const port = sidecar.server.address().port

// In-cluster this resolves to `dsh-files-<id>.<ns>.svc.cluster.local:8082`;
// here it points at the loopback sidecar bound above.
const local = new LocalUserFs(() => userRoot)
let ensured = 0
const remote = new K8sUserFs(async () => { ensured += 1 }, () => ({ host: '127.0.0.1', port }))

try {
  await remote.initUserRoot('u1')
  assert(ensured > 0, 'initUserRoot brings the sidecar up first')

  // Seed a plugin profile so the catalog read has something to find.
  const profile = join(userRoot, 'home', 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'p1'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['p1', '@deepseek-ai/core'] } } }))
  writeFileSync(join(profile, 'node_modules', 'p1', 'package.json'), JSON.stringify({ description: 'first plugin' }))

  let entries = await remote.listDir('u1', '')
  assert(entries.length === 0, 'fresh workspace is empty')

  const dirName = await remote.createEntry('u1', '', 'proj', 'dir')
  assert(dirName === 'proj', 'createEntry returns the sanitized name')
  assert(await remote.isDirectory('u1', 'proj'), 'created entry is a directory')

  const uploaded = await remote.upload('u1', 'proj', 'notes.txt', Buffer.from('hello sidecar'))
  assert(uploaded === 'notes.txt', 'upload returns the sanitized name')

  await remote.mkdir('u1', 'proj/sub')

  // Same volume, two implementations → identical view.
  entries = await remote.listDir('u1', 'proj')
  const localEntries = await local.listDir('u1', 'proj')
  assert(JSON.stringify(entries) === JSON.stringify(localEntries), 'sidecar and local agree on the listing')
  const file = entries.find((e) => e.name === 'notes.txt')
  assert(file.type === 'file' && file.size === 13, 'uploaded file has the right type/size')

  const plugins = await remote.listInstalledPlugins('u1')
  assert(plugins.length === 1 && plugins[0].id === 'p1', 'installation-scoped bundles are filtered out')
  assert(plugins[0].description === 'first plugin', 'plugin description comes from its package.json')
  assert(JSON.stringify(plugins) === JSON.stringify(await local.listInstalledPlugins('u1')), 'catalogs agree')

  await remote.writeHandoff('u1', JSON.stringify({ command: 'echo hi' }))

  // Error codes survive the HTTP hop as the same UserFsError the UI switches on.
  await rejectsWith(() => remote.listDir('u1', '../../etc'), 'bad_path', 'traversal rejected')
  await rejectsWith(() => remote.listDir('u1', 'nope'), 'not_found', 'missing dir is not_found')
  await rejectsWith(() => remote.createEntry('u1', '', 'proj', 'dir'), 'exists', 'duplicate create is exists')
  await rejectsWith(() => remote.createEntry('u1', 'nope', 'x', 'file'), 'parent_missing', 'missing parent')
  await rejectsWith(() => remote.upload('u1', '', '..', Buffer.from('x')), 'bad_name', 'path in name rejected')

  // resolvePath is pure POSIX path math on the in-Pod layout.
  assert(
    remote.resolvePath('u1', 'proj') === '/var/lib/dsh-server-login/users/u1/ws/proj',
    'resolvePath yields the in-Pod path',
  )
  let escaped = false
  try {
    remote.resolvePath('u1', '../../etc')
  } catch (err) {
    escaped = err instanceof UserFsError && err.code === 'bad_path'
  }
  assert(escaped, 'resolvePath rejects traversal')

  console.log('OK: file sidecar round-trip matches LocalUserFs')
} finally {
  await sidecar.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
