/**
 * Child-process helpers for the supervisor: env scrubbing and free-port lookup.
 *
 * Env scrubbing mirrors the harness `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN`
 * doctrine (packages/subprocess/subprocess/src/index.ts): build the child env
 * from a clean allowlist so no orchestrator secret leaks into a user DSH, then
 * inject only the resolved per-user values.
 * @module dsh-server-login/supervisor/spawn
 */

import { createServer } from 'node:net'

const ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LANG',
  'LC_ALL',
])

/** Drop credential-shaped and unknown env vars; keep only a safe allowlist. */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV.has(key) && value !== undefined) out[key] = value
  }
  return out
}

/** Reserve an ephemeral loopback port, release it, and return its number. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port !== undefined) resolve(port)
        else reject(new Error('could not reserve a free port'))
      })
    })
  })
}
