/**
 * {@link UserFs} factory. Picks the implementation from `deployMode`, the same
 * way {@link createDbAdapter} picks a DB backend and `buildServer` picks a
 * {@link Spawner}.
 * @module dsh-server-login/fs/provider
 */

import type { ServerConfig } from '../config.js'
import type { Endpoint } from '../supervisor/spawner.js'
import { FILE_SERVICE_PORT } from '../web/file-service.js'
import { K8sUserFs, type EnsureFileService } from './k8s-user-fs.js'
import { LocalUserFs } from './local-user-fs.js'
import type { UserFs } from './user-fs.js'
import { userRoot } from './workspace.js'

/** Headless Service fronting a user's file sidecar (docs/k8s.md §4.10). */
export function fileServiceName(userId: string): string {
  return `dsh-files-${userId}`
}

/** In-cluster address of a user's file sidecar. */
export function fileServiceEndpoint(namespace: string, userId: string): Endpoint {
  return { host: `${fileServiceName(userId)}.${namespace}.svc.cluster.local`, port: FILE_SERVICE_PORT }
}

/**
 * Build the configured per-user filesystem.
 *
 * `local` touches the users volume in-process. `k8s` delegates to each user's
 * file sidecar, which the spawner brings up on demand via `ensureFileService`.
 */
export function createUserFs(config: ServerConfig, ensureFileService?: EnsureFileService): UserFs {
  if (config.deployMode === 'k8s' && ensureFileService !== undefined) {
    return new K8sUserFs(ensureFileService, (userId) => fileServiceEndpoint(config.k8sNamespace, userId))
  }
  return new LocalUserFs((userId) => userRoot(config.dataRoot, userId))
}
