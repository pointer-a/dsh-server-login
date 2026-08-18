/**
 * Per-user DSH supervisor: main + watchdog process pair, health, teardown.
 *
 * Skeleton — P3 implements single-DSH launch + loopback port tracking + stop;
 * P5 implements the crash-takeover loop (diagnose → repair session log via
 * `interruptedTurnClosers`/`session-persistence` → repair root cause → resume).
 * @module dsh-server-login/supervisor/orchestrator
 */

import type { ServerConfig } from '../config.js'
import type { DshSpawnSpec } from './spawn.js'

/** A tracked child DSH (main or watchdog). */
export interface ManagedInstance {
  id: string
  userId: string
  workspaceId?: string
  role: 'main' | 'watchdog'
  pid?: number
  port?: number
  status: 'starting' | 'running' | 'crashed' | 'repairing' | 'stopped'
}

/**
 * Owns the lifecycle of all per-user DSH processes. State is a stub; the real
 * implementation persists into `dsh_instances` and drives spawn/kill/watch.
 */
export class Supervisor {
  private readonly instances = new Map<string, ManagedInstance>()

  constructor(private readonly config: ServerConfig) {}

  /** Build the per-role spawn spec for a user's workspace. (P3) */
  buildSpec(_userId: string, _workspaceId: string | undefined, _role: 'main' | 'watchdog'): DshSpawnSpec {
    throw new Error('Supervisor.buildSpec not implemented until P3')
  }

  /** Spawn and track a child DSH. (P3) */
  launch(_spec: DshSpawnSpec): ManagedInstance {
    throw new Error('Supervisor.launch not implemented until P3')
  }

  /** Stop a tracked instance with tree teardown. (P3) */
  stop(_id: string): void {
    throw new Error('Supervisor.stop not implemented until P3')
  }

  /** Teardown every tracked process on shutdown. */
  async teardown(): Promise<void> {
    this.instances.clear()
  }
}
