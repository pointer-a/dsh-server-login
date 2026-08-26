// LocalUserFs regression tests (node:test, against built lib/ — `npm test`
// builds first). Focus: the symlink-escape guard layered on top of lexical
// path containment. A link planted inside the workspace (`ws/link -> /etc`)
// passes the prefix check, so every operation must reject symlink components
// before touching the filesystem.
//
// Symlink creation is privilege-gated on Windows (junctions work unprivileged,
// file links need dev mode), so the link-based cases self-skip when the FS
// refuses to create one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalUserFs } from '../lib/fs/local-user-fs.js'
import { UserFsError } from '../lib/fs/user-fs.js'

const USER = 'u1'

function makeUser(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-lufs-'))
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }))
  const ws = join(dataRoot, 'users', USER, 'ws')
  mkdirSync(ws, { recursive: true })
  return { fs: new LocalUserFs((id) => join(dataRoot, 'users', id)), dataRoot, ws }
}

/** Create a link; false when the platform refuses (e.g. unprivileged Windows). */
function tryLink(target, path, type) {
  try {
    symlinkSync(target, path, type)
    return true
  } catch {
    return false
  }
}

function isBadPath(err) {
  return err instanceof UserFsError && err.code === 'bad_path'
}

test('upload/mkdir/listDir work through nested directories', async (t) => {
  const { fs } = makeUser(t)
  await fs.mkdir(USER, 'proj')
  assert.equal(await fs.upload(USER, 'proj', 'hello.txt', Buffer.from('hi')), 'hello.txt')
  const entries = await fs.listDir(USER, 'proj')
  assert.deepEqual(entries.map((e) => e.name).sort(), ['hello.txt'])
})

test('lexical traversal is still rejected with bad_path', async (t) => {
  const { fs } = makeUser(t)
  await assert.rejects(() => fs.upload(USER, '../outside', 'x.txt', Buffer.from('x')), isBadPath)
  await assert.rejects(() => fs.listDir(USER, '../../etc'), isBadPath)
})

test('upload through an in-workspace directory symlink is rejected', async (t) => {
  const { fs, dataRoot, ws } = makeUser(t)
  const outside = join(dataRoot, 'outside')
  mkdirSync(outside)
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  if (!tryLink(outside, join(ws, 'link'), type)) {
    t.skip('symlink creation unavailable on this host')
    return
  }
  await assert.rejects(() => fs.upload(USER, 'link', 'escaped.txt', Buffer.from('x')), isBadPath)
  await assert.rejects(() => fs.mkdir(USER, 'link/sub'), isBadPath)
  await assert.rejects(() => fs.listDir(USER, 'link'), isBadPath)
  await assert.rejects(() => fs.isDirectory(USER, 'link'), isBadPath)
})

test('upload onto an existing symlinked filename does not follow it', async (t) => {
  const { fs, ws } = makeUser(t)
  writeFileSync(join(ws, 'real.txt'), 'original')
  if (!tryLink(join(ws, 'real.txt'), join(ws, 'alias.txt'), 'file')) {
    t.skip('symlink creation unavailable on this host')
    return
  }
  await assert.rejects(() => fs.upload(USER, '', 'alias.txt', Buffer.from('evil')), isBadPath)
  assert.equal(readFileSync(join(ws, 'real.txt'), 'utf8'), 'original', 'target untouched')
})

test('missing path components end the walk and surface as not_found', async (t) => {
  const { fs } = makeUser(t)
  await assert.rejects(
    () => fs.isDirectory(USER, 'ghost/deep'),
    (err) => err instanceof UserFsError && err.code === 'not_found',
  )
})
