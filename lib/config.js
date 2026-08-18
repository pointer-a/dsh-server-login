/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh-server-login/config
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const DEFAULT_DSH_BIN = 'dsh';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
function toBool(value, fallback) {
    if (value === undefined)
        return fallback;
    return value === 'true' || value === '1';
}
/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh-server-login` (always writable for dev); production sets
 * `DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login`.
 */
export function resolveConfig(overrides = {}) {
    const dataRoot = overrides.dataRoot ?? process.env.DSH_SERVER_LOGIN_DATA_ROOT ?? join(homedir(), '.dsh-server-login');
    const port = overrides.port ?? process.env.DSH_SERVER_LOGIN_PORT ?? DEFAULT_PORT;
    return {
        host: overrides.host ?? DEFAULT_HOST,
        port: typeof port === 'number' ? port : Number(port),
        dbPath: overrides.dbPath ?? join(dataRoot, 'server-login.db'),
        dataRoot,
        dshBinPath: overrides.dshBinPath ?? process.env.DSH_SERVER_LOGIN_DSH_BIN ?? DEFAULT_DSH_BIN,
        logLevel: overrides.logLevel ?? DEFAULT_LOG_LEVEL,
        secureCookies: overrides.secureCookies ?? toBool(process.env.DSH_SERVER_LOGIN_SECURE_COOKIES, false),
        sessionTtlSeconds: Number(overrides.sessionTtlSeconds ?? process.env.DSH_SERVER_LOGIN_SESSION_TTL ?? DEFAULT_SESSION_TTL_SECONDS),
    };
}
//# sourceMappingURL=config.js.map