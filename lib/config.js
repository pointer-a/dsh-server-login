/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh-server-login/config
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const DEFAULT_DSH_COMMAND = ['dsh'];
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_RESTART_BACKOFF_MS = 1000;
const DEFAULT_ISOLATION_MODE = 'soft';
const DEFAULT_SPAWN_AS_USER_COMMAND = [
    'setpriv',
    '--reuid',
    '{UID}',
    '--regid',
    '{GID}',
    '--inh-caps=-all',
    '--clear-groups',
    '--',
];
const DEFAULT_BASE_UID = 100000;
const DEFAULT_BASE_DOMAIN = '';
const DEFAULT_COOKIE_DOMAIN = '';
function toBool(value, fallback) {
    if (value === undefined)
        return fallback;
    return value === 'true' || value === '1';
}
function parsePluginCatalog(json) {
    if (json === undefined)
        return [];
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed))
            return [];
        return parsed.flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null)
                return [];
            const { id, name, description } = entry;
            if (typeof id !== 'string' || typeof name !== 'string')
                return [];
            return [{ id, name, description: typeof description === 'string' ? description : '' }];
        });
    }
    catch {
        return [];
    }
}
/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh-server-login` (always writable for dev); production sets
 * `DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login`.
 */
export function resolveConfig(overrides = {}) {
    const dataRoot = overrides.dataRoot ?? process.env.DSH_SERVER_LOGIN_DATA_ROOT ?? join(homedir(), '.dsh-server-login');
    const port = overrides.port ?? process.env.DSH_SERVER_LOGIN_PORT ?? DEFAULT_PORT;
    const dshBin = process.env.DSH_SERVER_LOGIN_DSH_BIN;
    const isolationMode = overrides.isolationMode ?? DEFAULT_ISOLATION_MODE;
    return {
        host: overrides.host ?? DEFAULT_HOST,
        port: typeof port === 'number' ? port : Number(port),
        dbPath: overrides.dbPath ?? join(dataRoot, 'server-login.db'),
        dataRoot,
        dshCommand: overrides.dshCommand ?? (dshBin !== undefined ? [dshBin] : DEFAULT_DSH_COMMAND),
        availablePlugins: overrides.availablePlugins ?? parsePluginCatalog(process.env.DSH_SERVER_LOGIN_PLUGINS),
        logLevel: overrides.logLevel ?? DEFAULT_LOG_LEVEL,
        secureCookies: overrides.secureCookies ?? toBool(process.env.DSH_SERVER_LOGIN_SECURE_COOKIES, false),
        sessionTtlSeconds: Number(overrides.sessionTtlSeconds ?? process.env.DSH_SERVER_LOGIN_SESSION_TTL ?? DEFAULT_SESSION_TTL_SECONDS),
        maxUploadBytes: Number(overrides.maxUploadBytes ?? process.env.DSH_SERVER_LOGIN_MAX_UPLOAD ?? DEFAULT_MAX_UPLOAD_BYTES),
        restartBackoffMs: Number(overrides.restartBackoffMs ?? process.env.DSH_SERVER_LOGIN_RESTART_BACKOFF ?? DEFAULT_RESTART_BACKOFF_MS),
        isolationMode,
        spawnAsUserCommand: overrides.spawnAsUserCommand ?? DEFAULT_SPAWN_AS_USER_COMMAND,
        baseUid: Number(overrides.baseUid ?? process.env.DSH_SERVER_LOGIN_BASE_UID ?? DEFAULT_BASE_UID),
        baseDomain: overrides.baseDomain ?? process.env.DSH_SERVER_LOGIN_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN,
        cookieDomain: overrides.cookieDomain ?? process.env.DSH_SERVER_LOGIN_COOKIE_DOMAIN ?? DEFAULT_COOKIE_DOMAIN,
    };
}
//# sourceMappingURL=config.js.map