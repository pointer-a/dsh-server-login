/**
 * {@link UserFs} factory. Picks the implementation from `deployMode`, the same
 * way {@link createDbAdapter} picks a DB backend and `buildServer` picks a
 * {@link Spawner}.
 * @module dsh-server-login/fs/provider
 */

import type { ServerConfig } from '../config.js'
import { LocalUserFs } from './local-user-fs.js'
import type { UserFs } from './user-fs.js'
import { userRoot } from './workspace.js'

/**
 * Build the configured per-user filesystem.
 *
 * `local` touches the users volume in-process. `k8s` will delegate to the
 * per-user file sidecar; until that lands the local implementation is used,
 * which is correct for any deployment where the control plane still mounts the
 * volume.
 */
export function createUserFs(config: ServerConfig): UserFs {
  return new LocalUserFs((userId) => userRoot(config.dataRoot, userId))
}
