/**
 * Backend abstraction for per-user DSH lifecycle (docs/k8s.md §5.2).
 *
 * `local` spawns child processes (setuid/iptables) via `LocalSpawner`; `k8s`
 * creates/deletes per-user DSH Pods via the K8s API (`K8sSpawner`). The route
 * layer depends only on this interface, so both backends coexist behind the
 * same API. Shared instance/status types live here so neither backend owns
 * them.
 * @module dsh-server-login/supervisor/spawner
 */

export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped'
export type InstanceRole = 'main' | 'watchdog'

/** A tracked DSH instance (main or watchdog). `port`/`pid` are local-only. */
export interface Instance {
  id: string
  userId: string
  role: InstanceRole
  folder: string
  port?: number
  status: InstanceStatus
  pid?: number
  exitCode?: number
  lastError?: string
  /** Rendered cordis patch **content**, not a path — see {@link Spawner.launch}. */
  patch?: string
}

/** Thrown when a user already has a running main DSH. */
export class AlreadyRunningError extends Error {
  constructor(userId: string) {
    super(`user ${userId} already has a running DSH`)
    this.name = 'AlreadyRunningError'
  }
}

/** A user's main + watchdog pair. */
export interface UserStatus {
  main?: Instance
  watchdog?: Instance
}

/** The host:port the proxy forwards a user's DSH traffic to. */
export interface Endpoint {
  host: string
  port: number
}

/**
 * The lifecycle seam the route layer delegates to.
 *
 * `endpointFor` is spawner-specific: local → `127.0.0.1:<port>`, k8s → the
 * per-user Headless Service DNS (docs/k8s.md §5.4).
 *
 * `launch` takes the rendered cordis patch as **content**, not a path: under
 * k8s the control plane holds no user volume, so it can neither write the patch
 * nor read it back. `LocalSpawner` materializes it to a file (it does have the
 * volume) and `K8sSpawner` puts it straight into a ConfigMap.
 */
export interface Spawner {
  launch(userId: string, folder: string, patch?: string): Promise<Instance>
  restartMain(userId: string): Promise<Instance | undefined>
  spawnWatchdog(userId: string): Promise<Instance | undefined>
  status(userId: string): Promise<UserStatus>
  endpointFor(userId: string): Promise<Endpoint | undefined>
  stop(userId: string): Promise<void>
  teardown(): Promise<void>
  /** Make the user's file sidecar exist and be ready (k8s). No-op under local,
   * where the control plane touches the volume in-process. */
  ensureFileService(userId: string): Promise<void>
}
