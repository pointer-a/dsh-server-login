/**
 * Concrete child-DSH spawn + env scrubbing.
 *
 * Mirrors the harness `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN` doctrine
 * (packages/subprocess/subprocess/src/index.ts): build the child env from a
 * clean allowlist so no orchestrator secret leaks into a user DSH, then inject
 * only the resolved per-user values.
 * @module dsh-server-login/supervisor/spawn
 */
import { spawn } from 'node:child_process';
const ALLOWED_ENV = new Set([
    'PATH',
    'HOME',
    'USER',
    'TMP',
    'TEMP',
    'TMPDIR',
    'SYSTEMROOT',
    'SystemRoot',
    'PATHEXT',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'LANG',
    'LC_ALL',
]);
/** Drop credential-shaped and unknown env vars; keep only a safe allowlist. */
export function scrubEnv(env) {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (ALLOWED_ENV.has(key) && value !== undefined)
            out[key] = value;
    }
    return out;
}
/**
 * Launch one child DSH. The orchestrator is the tree parent (`detached: false`)
 * so signals propagate; P3 adds port probing and stderr capture.
 */
export function spawnDsh(config, spec) {
    return spawn(config.dshBinPath, ['--profile', spec.profile, '--patch', spec.patchPath, '--cwd', spec.cwd], {
        cwd: spec.cwd,
        env: {
            ...scrubEnv(process.env),
            DSH_HOME: spec.homeDir,
            DEEPSEEK_API_KEY: spec.apiKey,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
//# sourceMappingURL=spawn.js.map