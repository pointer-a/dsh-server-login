/**
 * Per-user DSH supervisor: one main DSH per user, loopback port assignment,
 * status tracking, and tree teardown.
 *
 * P3 implements single-DSH launch/stop/status. P5 adds the watchdog/repair pair
 * (crash diagnosis → session-log repair → resume) on top of this lifecycle.
 * @module dsh-server-login/supervisor/orchestrator
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { findFreePort, scrubEnv } from './spawn.js'

export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped'

/** A tracked child DSH (main). */
export interface Instance {
  id: string
  userId: string
  folder: string
  port: number
  status: InstanceStatus
  pid?: number
  exitCode?: number
}

/** Thrown when a user already has a running main DSH. */
export class AlreadyRunningError extends Error {
  constructor(userId: string) {
    super(`user ${userId} already has a running DSH`)
    this.name = 'AlreadyRunningError'
  }
}

/**
 * Owns the lifecycle of all per-user DSH processes. State is in-memory (a
 * running instance dies with the orchestrator); DB reconciliation is a P3+
 * follow-up.
 */
export class Supervisor {
  private readonly instances = new Map<string, Instance>()
  private readonly children = new Map<string, ChildProcess>()

  constructor(private readonly config: ServerConfig) {}

  /** Spawn a main DSH for `userId` rooted at the given workspace folder. */
  async launch(userId: string, folder: string, patchPath?: string): Promise<Instance> {
    if (this.instances.has(userId)) throw new AlreadyRunningError(userId)

    const port = await findFreePort()
    const homeDir = join(this.config.dataRoot, 'users', userId, 'home')
    const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
    const [command = 'dsh', ...args] = this.config.dshCommand

    const launchArgs = ['--profile', 'web', '--cwd', folder]
    if (patchPath !== undefined) launchArgs.push('--patch', patchPath)
    const child = spawn(command, [...args, ...launchArgs], {
      cwd: folder,
      env: {
        ...scrubEnv(process.env),
        DSH_HOME: homeDir,
        DEEPSEEK_API_KEY: apiKey,
        DSH_SERVER_LOGIN_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const instance: Instance = {
      id: randomUUID(),
      userId,
      folder,
      port,
      status: 'starting',
      pid: child.pid ?? undefined,
    }
    this.instances.set(userId, instance)
    this.children.set(userId, child)

    child.on('spawn', () => {
      instance.status = 'running'
    })
    child.on('error', () => {
      instance.status = 'crashed'
      this.instances.delete(userId)
      this.children.delete(userId)
    })
    child.on('exit', (code) => {
      if (instance.status !== 'stopped') instance.status = 'crashed'
      instance.exitCode = code ?? undefined
      this.instances.delete(userId)
      this.children.delete(userId)
    })
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)

    return instance
  }

  /** Current instance for a user, if any. */
  statusFor(userId: string): Instance | undefined {
    return this.instances.get(userId)
  }

  /** Loopback port of the user's running instance, if any. */
  portFor(userId: string): number | undefined {
    return this.instances.get(userId)?.port
  }

  /** Stop a user's instance with SIGTERM, escalating to SIGKILL after a grace. */
  stop(userId: string): void {
    const child = this.children.get(userId)
    const instance = this.instances.get(userId)
    if (instance !== undefined) instance.status = 'stopped'
    this.instances.delete(userId)
    this.children.delete(userId)
    if (child === undefined) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5000)
    timer.unref()
  }

  /** Stop every tracked instance on shutdown. */
  teardown(): void {
    for (const userId of [...this.instances.keys()]) this.stop(userId)
  }
}
