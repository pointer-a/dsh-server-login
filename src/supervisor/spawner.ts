/**
 * Backend abstraction for per-user DSH lifecycle (docs/k8s.md §5.2).
 *
 * `local` spawns child processes (setuid/iptables) via `LocalSpawner`; `k8s`
 * creates/deletes per-user DSH Pods via the K8s API (`K8sSpawner`). The
 * Supervisor depends only on this interface, so both backends coexist behind
 * the same route layer.
 * @module dsh-server-login/supervisor/spawner
 */

import type { InstanceRole, InstanceStatus } from './orchestrator.js'

/** Launch parameters for a per-user DSH instance. */
export interface SpawnSpec {
  /** Working directory the DSH session starts in (the user's chosen folder). */
  folder: string
  /** Rendered cordis patch to inject via --patch (both roles). */
  patchPath?: string
}

/** A launched instance's public state (spawner-internal details stay private). */
export interface SpawnHandle {
  id: string
  userId: string
  role: InstanceRole
  status: InstanceStatus
}

/** The host:port the proxy forwards a user's DSH traffic to. */
export interface Endpoint {
  host: string
  port: number
}

/** A user's main + watchdog pair, for status reports. */
export interface UserHandles {
  main?: SpawnHandle
  watchdog?: SpawnHandle
}

/**
 * The lifecycle seam the Supervisor delegates to.
 *
 * `endpointFor` is spawner-specific: local → `127.0.0.1:<port>`, k8s → the
 * per-user Headless Service DNS (docs/k8s.md §5.4). `restartMain` and
 * `teardown` are composed by the Supervisor from `launch`/`stop` and are not
 * part of this interface.
 */
export interface Spawner {
  launch(userId: string, spec: SpawnSpec): Promise<SpawnHandle>
  stop(userId: string): Promise<void>
  status(userId: string): Promise<UserHandles>
  spawnWatchdog(userId: string): Promise<SpawnHandle | undefined>
  endpointFor(userId: string): Endpoint | undefined
}
