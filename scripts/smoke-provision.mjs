// Auto-provision flow: when DSH_SERVER_LOGIN_PROVISION_SCRIPT is set, registering
// a user runs the script with (userId, username).
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-provision-'))
const fakeScript = join(dataRoot, 'provision.sh')
const log = join(dataRoot, 'provision.log')
const { writeFileSync } = await import('node:fs')
writeFileSync(
  fakeScript,
  `#!/usr/bin/env bash
set -euo pipefail
echo "$1 $2" >> "${log}"
`,
)
chmodSync(fakeScript, 0o755)

const app = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    provisionScript: fakeScript,
  }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

try {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dana', password: 'danapass123' }),
  })
  console.log('register ->', res.status)
  assert(res.status === 201, 'registration succeeds')

  const line = readFileSync(log, 'utf8').trim().split(/\s+/)
  console.log('provision invoked with ->', line)
  assert(line[1] === 'dana', 'provision script got the username')

  const auditRow = app.db.prepare('SELECT detail FROM audit_log WHERE action = ?').get('register')
  console.log('audit ->', auditRow.detail)
  assert(auditRow.detail.includes('provision') && auditRow.detail.includes('ok'), 'audit records provision ok')

  console.log('OK: auto-provision flow passed')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
