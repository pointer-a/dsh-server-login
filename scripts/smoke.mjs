// Smoke test: boot the orchestrator on an ephemeral port, hit `/` and
// `/api/auth/me`, then close cleanly. Proves the scaffold compiles, migrates
// the DB, serves static, and exercises the authn guard.
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'

const app = await buildServer(resolveConfig({ port: 0, dbPath: './dev.local.db' }))
await app.listen({ port: 0 })
const addr = app.server.address()
const base = `http://127.0.0.1:${addr.port}`

const home = await fetch(base + '/')
console.log('GET /            ->', home.status, (await home.text()).replace(/\s+/g, ' ').slice(0, 60))

const me = await fetch(base + '/api/auth/me')
console.log('GET /api/auth/me ->', me.status, await me.text())

await app.close()
console.log('OK: booted, migrated, served, closed')
