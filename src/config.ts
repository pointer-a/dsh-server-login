/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh-server-login/config
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Isolation tier. `soft` = per-user home/workspace + sandbox (same OS user);
 * `account` = per-user OS account via a setuid wrapper (Linux, needs root). */
export type IsolationMode = 'soft' | 'account'

/** A plugin available for per-folder enablement (`id` = package name). */
export interface PluginInfo {
  id: string
  name: string
  description: string
}

/** Resolved, immutable runtime configuration. */
export interface ServerConfig {
  /** Bind host for the orchestrator HTTP server. */
  host: string
  /** Bind port; `0` requests an ephemeral port. */
  port: number
  /** SQLite database path. */
  dbPath: string
  /** Root under which per-user homes (`users/<id>/home`) and workspaces live. */
  dataRoot: string
  /** Argv used to launch a child DSH; first element is the executable. */
  dshCommand: string[]
  /** Catalog of plugins users may enable per folder. */
  availablePlugins: PluginInfo[]
  /** Pino log level. */
  logLevel: string
  /** Set the `Secure` flag on session cookies (enable behind HTTPS). */
  secureCookies: boolean
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Max upload request body in bytes (base64 JSON; ~0.75× the file size). */
  maxUploadBytes: number
  /** Delay before auto-restarting a crashed child DSH, in milliseconds. */
  restartBackoffMs: number
  /** Isolation tier (see {@link IsolationMode}). */
  isolationMode: IsolationMode
  /** Argv prefix that drops privileges; `{UID}`/`{GID}` are substituted. */
  spawnAsUserCommand: string[]
  /** Base uid for the deterministic per-user uid. */
  baseUid: number
  /** Parent domain for per-user subdomains (`<username>.<baseDomain>`); empty = disabled. */
  baseDomain: string
  /** Cookie `Domain` value (e.g. `.example.com`) so the session reaches subdomains; empty = host-only. */
  cookieDomain: string
  /** Whether to pass `--patch` to child DSHs (needs a dsh CLI that supports it). */
  enablePatch: boolean
  /** Secret used to encrypt per-user secrets at rest (from env or dataRoot/secret.key). */
  encryptionSecret: string
}

/** Untyped overrides collected from argv / env. */
export interface ConfigOverrides {
  host?: string
  port?: string | number
  dbPath?: string
  dataRoot?: string
  dshCommand?: string[]
  availablePlugins?: PluginInfo[]
  logLevel?: string
  secureCookies?: boolean
  sessionTtlSeconds?: number | string
  maxUploadBytes?: number | string
  restartBackoffMs?: number | string
  isolationMode?: IsolationMode
  spawnAsUserCommand?: string[]
  baseUid?: number | string
  baseDomain?: string
  cookieDomain?: string
  enablePatch?: boolean
  encryptionSecret?: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const DEFAULT_DSH_COMMAND = ['dsh']
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_RESTART_BACKOFF_MS = 1000
const DEFAULT_ISOLATION_MODE: IsolationMode = 'soft'
const DEFAULT_SPAWN_AS_USER_COMMAND = [
  'setpriv',
  '--reuid',
  '{UID}',
  '--regid',
  '{GID}',
  '--inh-caps=-all',
  '--clear-groups',
  '--',
]
const DEFAULT_BASE_UID = 100000
const DEFAULT_BASE_DOMAIN = ''
const DEFAULT_COOKIE_DOMAIN = ''
const DEFAULT_ENABLE_PATCH = false

/** Load the encryption secret from env, or persist a generated one at
 * `<dataRoot>/secret.key` (0600) so it survives restarts without setup. */
function resolveEncryptionSecret(dataRoot: string): string {
  const fromEnv = process.env.DSH_SERVER_LOGIN_SECRET
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const path = join(dataRoot, 'secret.key')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing !== '') return existing
  } catch {
    // fall through to generate
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path, secret, { mode: 0o600 })
  return secret
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

function parsePluginCatalog(json: string | undefined): PluginInfo[] {
  if (json === undefined) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): PluginInfo[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const { id, name, description } = entry as Record<string, unknown>
      if (typeof id !== 'string' || typeof name !== 'string') return []
      return [{ id, name, description: typeof description === 'string' ? description : '' }]
    })
  } catch {
    return []
  }
}

/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh-server-login` (always writable for dev); production sets
 * `DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login`.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const dataRoot =
    overrides.dataRoot ?? process.env.DSH_SERVER_LOGIN_DATA_ROOT ?? join(homedir(), '.dsh-server-login')
  const port = overrides.port ?? process.env.DSH_SERVER_LOGIN_PORT ?? DEFAULT_PORT
  const dshBin = process.env.DSH_SERVER_LOGIN_DSH_BIN
  const isolationMode = overrides.isolationMode ?? DEFAULT_ISOLATION_MODE
  return {
    host: overrides.host ?? DEFAULT_HOST,
    port: typeof port === 'number' ? port : Number(port),
    dbPath: overrides.dbPath ?? join(dataRoot, 'server-login.db'),
    dataRoot,
    dshCommand: overrides.dshCommand ?? (dshBin !== undefined ? [dshBin] : DEFAULT_DSH_COMMAND),
    availablePlugins: overrides.availablePlugins ?? parsePluginCatalog(process.env.DSH_SERVER_LOGIN_PLUGINS),
    logLevel: overrides.logLevel ?? DEFAULT_LOG_LEVEL,
    secureCookies:
      overrides.secureCookies ?? toBool(process.env.DSH_SERVER_LOGIN_SECURE_COOKIES, false),
    sessionTtlSeconds: Number(
      overrides.sessionTtlSeconds ?? process.env.DSH_SERVER_LOGIN_SESSION_TTL ?? DEFAULT_SESSION_TTL_SECONDS,
    ),
    maxUploadBytes: Number(
      overrides.maxUploadBytes ?? process.env.DSH_SERVER_LOGIN_MAX_UPLOAD ?? DEFAULT_MAX_UPLOAD_BYTES,
    ),
    restartBackoffMs: Number(
      overrides.restartBackoffMs ?? process.env.DSH_SERVER_LOGIN_RESTART_BACKOFF ?? DEFAULT_RESTART_BACKOFF_MS,
    ),
    isolationMode,
    spawnAsUserCommand: overrides.spawnAsUserCommand ?? DEFAULT_SPAWN_AS_USER_COMMAND,
    baseUid: Number(overrides.baseUid ?? process.env.DSH_SERVER_LOGIN_BASE_UID ?? DEFAULT_BASE_UID),
    baseDomain: overrides.baseDomain ?? process.env.DSH_SERVER_LOGIN_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN,
    cookieDomain: overrides.cookieDomain ?? process.env.DSH_SERVER_LOGIN_COOKIE_DOMAIN ?? DEFAULT_COOKIE_DOMAIN,
    enablePatch: overrides.enablePatch ?? toBool(process.env.DSH_SERVER_LOGIN_ENABLE_PATCH, DEFAULT_ENABLE_PATCH),
    encryptionSecret:
      overrides.encryptionSecret ?? resolveEncryptionSecret(dataRoot),
  }
}
