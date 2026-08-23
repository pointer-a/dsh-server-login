/**
 * Per-user DSH supervisor: a resident main DSH plus an **on-demand** watchdog.
 *
 * The watchdog is not spawned at launch; it is pulled up once when the main
 * crashes (to repair) or when a post-restart command must be executed. This
 * keeps the steady-state footprint at one process per active user while still
 * providing crash repair + command handoff. The watchdog's agent-level
 * repair/session-resume is harness-internal and deferred to real-harness
 * integration (see docs/blueprint.md §4).
 * @module dsh-server-login/supervisor/orchestrator
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { createPortGuard, type PortGuard } from './firewall.js'
import { findFreePort, scrubEnv } from './spawn.js'
import {
  AlreadyRunningError,
  type Endpoint,
  type Instance,
  type InstanceRole,
  type InstanceStatus,
  type Spawner,
  type UserStatus,
} from './spawner.js'

// Re-exported so existing importers (routes) keep resolving from this module.
export { AlreadyRunningError, type Instance, type InstanceRole, type InstanceStatus, type UserStatus }

/** Task given to the one-shot headless watchdog so it doesn't error on a
 * missing task; executes any post-restart command from the handoff path. */
const WATCHDOG_TASK = 'Read DSH_SERVER_LOGIN_HANDOFF_PATH. If it contains a JSON {"command": ...}, run that command. Then exit.'

/**
 * Local backend: owns the lifecycle of per-user DSH process pairs via
 * child_process. State is in-memory. Implements {@link Spawner}.
 */
export class LocalSpawner implements Spawner {
  private readonly mains = new Map<string, Instance>()
  private readonly watchdogs = new Map<string, Instance>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly restartTimers = new Map<string, NodeJS.Timeout>()

  private readonly portGuard: PortGuard | undefined

  constructor(
    private readonly config: ServerConfig,
    /** Resolve the user's own API key (decrypted); null = user has none. */
    private readonly resolveApiKey: (userId: string) => Promise<string | null>,
    /** Resolve the user's assigned Linux uid (falls back to hash when unset). */
    private readonly resolveUid: (userId: string) => Promise<number>,
  ) {
    this.portGuard = createPortGuard(config.portGuard)
  }

  /** Spawn the resident main DSH for a user (watchdog is pulled up on demand). */
  async launch(userId: string, folder: string, patch?: string): Promise<Instance> {
    if (this.mains.has(userId)) throw new AlreadyRunningError(userId)
    return await this.spawnInstance(userId, 'main', folder, patch)
  }

  /** Stop the current main (clean) and respawn it with the same folder/patch. */
  async restartMain(userId: string): Promise<Instance | undefined> {
    const current = this.mains.get(userId)
    if (current === undefined) return undefined
    this.killInstance(userId, current)
    return await this.spawnInstance(userId, 'main', current.folder, current.patch)
  }

  /** Spawn a one-shot watchdog for the user's current main (repair / execute). */
  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    if (!this.config.enablePatch) return undefined // watchdog needs the runtime patch
    if (this.watchdogs.has(userId)) return this.watchdogs.get(userId)
    const main = this.mains.get(userId)
    if (main === undefined) return undefined
    return await this.spawnInstance(userId, 'watchdog', main.folder, main.patch)
  }

  /** Current main + watchdog for a user. */
  async status(userId: string): Promise<UserStatus> {
    return { main: this.mains.get(userId), watchdog: this.watchdogs.get(userId) }
  }

  /** Endpoint the proxy forwards to (local → the running main's loopback port). */
  async endpointFor(userId: string): Promise<Endpoint | undefined> {
    const port = this.mains.get(userId)?.port
    return port === undefined ? undefined : { host: '127.0.0.1', port }
  }

  /** Stop both processes for a user (cancelling any pending restart). */
  async stop(userId: string): Promise<void> {
    const timer = this.restartTimers.get(userId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.restartTimers.delete(userId)
    }
    const main = this.mains.get(userId)
    const watchdog = this.watchdogs.get(userId)
    if (main !== undefined) this.killInstance(userId, main)
    if (watchdog !== undefined) this.killInstance(userId, watchdog)
    this.mains.delete(userId)
    this.watchdogs.delete(userId)
  }

  /** Stop every tracked process on shutdown. */
  async teardown(): Promise<void> {
    for (const userId of [...this.mains.keys(), ...this.watchdogs.keys()]) await this.stop(userId)
  }

  private handoffPath(userId: string): string {
    return join(this.config.dataRoot, 'users', userId, 'handoff.json')
  }

  /** Materialize the rendered patch so the dsh CLI can `--patch <file>` it.
   * Per role, so a watchdog spawning alongside its main never races the file. */
  private writePatch(userId: string, role: InstanceRole, patch: string): string {
    const dir = join(this.config.dataRoot, 'users', userId, 'patches')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${role}.yml`)
    writeFileSync(path, patch)
    return path
  }

  private async baseEnv(userId: string): Promise<Record<string, string>> {
    const home = join(this.config.dataRoot, 'users', userId, 'home')
    const workspace = join(this.config.dataRoot, 'users', userId, 'ws')
    const apiKey = await this.resolveApiKey(userId)
    return {
      ...scrubEnv(process.env),
      // HOME drives the child's directory picker default (homedir()); point it
      // at the user's workspace so their folders show, not DSH's internal home.
      HOME: workspace,
      // DSH's own state (profiles/sessions/credentials) stays in `home`.
      DSH_HOME: home,
      // Each user's own key; omit entirely when unset so the harness reports
      // "no key" instead of a header-hostile value.
      ...(apiKey !== null ? { DEEPSEEK_API_KEY: apiKey } : {}),
    }
  }

  private async spawnInstance(userId: string, role: InstanceRole, folder: string, patch?: string): Promise<Instance> {
    const isMain = role === 'main'
    const port = isMain ? await findFreePort() : undefined
    const instance: Instance = {
      id: randomUUID(),
      userId,
      role,
      folder,
      port,
      status: 'starting',
      patch,
    }
    const map = role === 'main' ? this.mains : this.watchdogs
    map.set(userId, instance)

    const [command = 'dsh', ...args] = this.config.dshCommand
    const launchArgs = ['--profile', role === 'main' ? 'web' : 'headless']
    // --patch is a launcher flag and must precede any app/inner args (--host/--port
    // for web, the task string for headless): dsh forwards the first unrecognized
    // token onward, so a trailing --patch reaches the app as an unknown option.
    // Off by default so the child boots even on older dsh versions.
    if (this.config.enablePatch && patch !== undefined) {
      launchArgs.push('--patch', this.writePatch(userId, role, patch))
    }
    if (role === 'main') {
      launchArgs.push('--host', '127.0.0.1', '--port', String(port))
    } else {
      launchArgs.push(WATCHDOG_TASK)
    }

    const env: Record<string, string> = {
      ...(await this.baseEnv(userId)),
      DSH_SERVER_LOGIN_ROLE: role,
      DSH_SERVER_LOGIN_HANDOFF_PATH: this.handoffPath(userId), // both roles: main writes, watchdog reads
    }
    if (isMain) {
      env.DSH_SERVER_LOGIN_PORT = String(port)
    }

    const child = await this.spawnAsUser(userId, command, [...args, ...launchArgs], { cwd: folder, env })
    this.trackChild(userId, instance, child)
    return instance
  }

  /** Spawn the child, optionally through the account-level setuid wrapper. */
  private async spawnAsUser(
    userId: string,
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ): Promise<ChildProcess> {
    const stdio: StdioOptions = ['ignore', 'pipe', 'pipe']
    if (this.config.isolationMode !== 'account') {
      return spawn(command, args, { ...options, stdio })
    }
    const uid = await this.resolveUid(userId)
    const prefix = this.config.spawnAsUserCommand.map((part) =>
      part.replaceAll('{UID}', String(uid)).replaceAll('{GID}', String(uid)),
    )
    const [asCommand = 'setpriv', ...asArgs] = prefix
    return spawn(asCommand, [...asArgs, command, ...args], { ...options, stdio })
  }

  private trackChild(userId: string, instance: Instance, child: ChildProcess): void {
    this.children.set(instance.id, child)
    child.on('spawn', () => {
      instance.status = 'running'
      instance.pid = child.pid ?? undefined
      if (instance.role === 'main' && instance.port !== undefined && this.portGuard !== undefined) {
        try {
          this.portGuard.install(instance.port)
        } catch (error) {
          // Fail closed: without the port guard a co-tenant could reach this
          // DSH's loopback RPC directly. Kill the just-spawned child and mark
          // the instance crashed rather than serve unguarded.
          instance.status = 'crashed'
          instance.lastError = error instanceof Error ? error.message : String(error)
          child.kill('SIGKILL')
        }
      }
    })
    child.stdout?.pipe(process.stdout)
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048)
      // Also surface the child's stderr on the orchestrator's own stderr so a
      // boot crash is visible in journald instead of only in lastError.
      process.stderr.write(`[dsh-child ${instance.role}] ${chunk.toString()}`)
    })
    child.on('error', (err) => {
      instance.status = 'crashed'
      instance.lastError = err.message
      this.children.delete(instance.id)
    })
    child.on('exit', (code) => {
      instance.exitCode = code ?? undefined
      this.children.delete(instance.id)
      // Release the loopback port guard as soon as the main's process is gone
      // (explicit stop, restart, and crash all funnel through this handler).
      if (instance.role === 'main' && instance.port !== undefined) {
        this.portGuard?.remove(instance.port)
      }
      const map = instance.role === 'main' ? this.mains : this.watchdogs
      // Only act if this instance is still the current one (avoid a stale
      // exit handler touching a freshly restarted instance).
      if (map.get(userId)?.id !== instance.id) return
      if (instance.status === 'stopped') {
        map.delete(userId)
        return
      }
      // A one-shot watchdog that finished cleanly is not restarted.
      if (instance.role === 'watchdog' && code === 0) {
        instance.status = 'stopped'
        map.delete(userId)
        return
      }
      instance.status = 'crashed'
      instance.lastError = stderrTail.slice(-500) || undefined
      if (instance.role === 'main') {
        void this.spawnWatchdog(userId)
        this.scheduleRestart(userId, instance)
      } else {
        map.delete(userId)
      }
    })
  }

  private scheduleRestart(userId: string, instance: Instance): void {
    const timer = setTimeout(() => {
      this.restartTimers.delete(userId)
      void this.spawnInstance(userId, instance.role, instance.folder, instance.patch)
    }, this.config.restartBackoffMs)
    timer.unref()
    this.restartTimers.set(userId, timer)
  }

  private killInstance(userId: string, instance: Instance): void {
    instance.status = 'stopped'
    const child = this.children.get(instance.id)
    if (child === undefined) return
    child.kill('SIGTERM')
    const killer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5000)
    killer.unref()
  }
}
