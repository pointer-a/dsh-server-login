/**
 * Runtime plugin loaded into each child DSH. It is part of THIS bundle (not a
 * harness modification) and reads the env contract the orchestrator sets at
 * spawn time:
 *
 *   DSH_SERVER_LOGIN_PORT          — loopback port the web server must bind (main)
 *   DSH_SERVER_LOGIN_ROLE          — 'main' | 'watchdog'
 *   DSH_SERVER_LOGIN_HANDOFF_PATH  — post-restart command handoff file (watchdog)
 *   DSH_HOME / DEEPSEEK_API_KEY    — per-user home + platform key
 *
 * The web server's port is bound from this value (the deployment patch overrides
 * the harness webserver row — see docs/deployment.md); the watchdog's repair /
 * session-resume is the harness-side agent behavior, wired at real-harness
 * integration. This plugin currently logs the resolved values so operators can
 * verify the contract reached the child.
 * @module dsh-server-login/runtime
 */

export const name = 'dsh-server-login-runtime'

export interface RuntimeEnv {
  role: 'main' | 'watchdog'
  port?: number
  handoffPath?: string
}

/** Parse the env contract set by the orchestrator. */
export function readRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const role = env.DSH_SERVER_LOGIN_ROLE === 'watchdog' ? 'watchdog' : 'main'
  const port = Number(env.DSH_SERVER_LOGIN_PORT ?? '')
  const handoffPath = env.DSH_SERVER_LOGIN_HANDOFF_PATH
  return {
    role,
    ...(Number.isFinite(port) && port > 0 ? { port } : {}),
    ...(handoffPath !== undefined && handoffPath !== '' ? { handoffPath } : {}),
  }
}

/** Cordis entry. Logs the resolved env so the contract is observable. */
export function apply(): void {
  const runtime = readRuntimeEnv()
  // eslint-disable-next-line no-console
  console.log(
    `[dsh-server-login-runtime] role=${runtime.role} port=${runtime.port ?? ''} handoff=${runtime.handoffPath ?? ''}`,
  )
}
