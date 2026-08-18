/**
 * Concrete child-DSH spawn + env scrubbing.
 *
 * Mirrors the harness `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN` doctrine
 * (packages/subprocess/subprocess/src/index.ts): build the child env from a
 * clean allowlist so no orchestrator secret leaks into a user DSH, then inject
 * only the resolved per-user values.
 * @module dsh-server-login/supervisor/spawn
 */
import { type ChildProcess } from 'node:child_process';
import type { ServerConfig } from '../config.js';
/** Everything a child DSH needs to launch. */
export interface DshSpawnSpec {
    profile: 'web' | 'headless';
    patchPath: string;
    cwd: string;
    homeDir: string;
    apiKey: string;
}
/** Drop credential-shaped and unknown env vars; keep only a safe allowlist. */
export declare function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string>;
/**
 * Launch one child DSH. The orchestrator is the tree parent (`detached: false`)
 * so signals propagate; P3 adds port probing and stderr capture.
 */
export declare function spawnDsh(config: ServerConfig, spec: DshSpawnSpec): ChildProcess;
