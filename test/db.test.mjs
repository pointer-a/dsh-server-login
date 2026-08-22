// DB adapter regression tests (node:test). Runs against the built `lib/`
// output — `npm test` builds first. Covers the constraint-mapping and
// transaction semantics shared by both backends:
//   - unique / foreign-key errors converge on UniqueViolationError /
//     ForeignKeyViolationError
//   - the "disable-all-then-enable-one" credential upsert keeps exactly one
//     enabled key under concurrent writes
//   - concurrent createUser / audit writes land cleanly
// The Postgres suite self-skips unless DSH_SERVER_LOGIN_TEST_DB_URL is set
// (mirrors the CI e2e self-skip convention).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqliteAdapter } from '../lib/db/sqlite.js'
import { openPgAdapter } from '../lib/db/pg.js'
import { ForeignKeyViolationError, UniqueViolationError } from '../lib/db/errors.js'

const user = (id, username) => ({ id, username, passHash: 'x', role: 'active', homeDir: `/home/${username}` })

function register(backend, makeAdapter) {
  test(`${backend}: duplicate username → UniqueViolationError`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await assert.rejects(() => db.createUser(user('b', 'alice')), UniqueViolationError)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: session for unknown user → ForeignKeyViolationError`, async () => {
    const db = await makeAdapter()
    try {
      await assert.rejects(
        () => db.createSession({ tokenHash: 't', userId: 'missing', expiresAt: Date.now() + 1000 }),
        ForeignKeyViolationError,
      )
    } finally {
      await db.close()
    }
  })

  test(`${backend}: concurrent setCredentialKey keeps exactly one enabled`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => db.setCredentialKey('a', `k${i}`, `ref${i}`)),
      )
      const keys = await db.listCredentialKeys('a')
      assert.equal(keys.filter((k) => k.enabled).length, 1, 'exactly one key enabled')
      const ref = await db.getEnabledCredentialKeyRef('a')
      assert.ok(ref !== null && ref.startsWith('ref'), 'enabled key has a ref')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: selectCredentialKey flips the enabled key`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      const k1 = await db.setCredentialKey('a', 'k1', 'r1')
      await db.setCredentialKey('a', 'k2', 'r2')
      assert.equal(await db.getEnabledCredentialKeyRef('a'), 'r2')
      assert.equal(await db.selectCredentialKey('a', k1.id), true)
      assert.equal(await db.getEnabledCredentialKeyRef('a'), 'r1')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: concurrent createUser`, async () => {
    const db = await makeAdapter()
    try {
      await Promise.all(Array.from({ length: 20 }, (_, i) => db.createUser(user(`u${i}`, `user${i}`))))
      assert.equal((await db.listPublicUsers()).length, 20)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: getOrCreateWorkspace is idempotent`, async () => {
    const db = await makeAdapter()
    try {
      await db.createUser(user('a', 'alice'))
      const w1 = await db.getOrCreateWorkspace('a', 'proj/one')
      const w2 = await db.getOrCreateWorkspace('a', 'proj/one')
      assert.equal(w1.id, w2.id)
    } finally {
      await db.close()
    }
  })

  test(`${backend}: createUser assigns a unique uid`, async () => {
    const db = await makeAdapter()
    try {
      const a = await db.createUser(user('a', 'alice'))
      const b = await db.createUser(user('b', 'bob'))
      assert.ok(a.uid !== null && a.uid !== undefined, 'first user has a uid')
      assert.notEqual(a.uid, b.uid, 'uids are unique across users')
      assert.equal((await db.listUsersWithoutUid()).length, 0, 'no unassigned uids remain')
    } finally {
      await db.close()
    }
  })

  test(`${backend}: concurrent audit writes`, async () => {
    const db = await makeAdapter()
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => db.audit('system', 'test', `detail-${i}`)))
    } finally {
      await db.close()
    }
  })
}

register('sqlite', () => new SqliteAdapter(':memory:', 100000))

const pgUrl = process.env.DSH_SERVER_LOGIN_TEST_DB_URL
if (pgUrl) {
  register('pg', () => openPgAdapter(pgUrl, 100000))
} else {
  test('pg: skipped — set DSH_SERVER_LOGIN_TEST_DB_URL to run', { skip: 'no DSH_SERVER_LOGIN_TEST_DB_URL' }, () => {})
}
