/**
 * Child-process helpers for the supervisor: env scrubbing and free-port lookup.
 *
 * Env scrubbing mirrors the harness `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN`
 * doctrine (packages/subprocess/subprocess/src/index.ts): build the child env
 * from a clean allowlist so no orchestrator secret leaks into a user DSH, then
 * inject only the resolved per-user values.
 * @module dsh-server-login/supervisor/spawn
 */
/** Drop credential-shaped and unknown env vars; keep only a safe allowlist. */
export declare function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string>;
/** Reserve an ephemeral loopback port, release it, and return its number. */
export declare function findFreePort(): Promise<number>;
