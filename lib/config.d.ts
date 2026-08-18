/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh-server-login/config
 */
/** Resolved, immutable runtime configuration. */
export interface ServerConfig {
    /** Bind host for the orchestrator HTTP server. */
    host: string;
    /** Bind port; `0` requests an ephemeral port. */
    port: number;
    /** SQLite database path. */
    dbPath: string;
    /** Root under which per-user homes (`users/<id>/home`) and workspaces live. */
    dataRoot: string;
    /** Path/command used to launch a child DSH process. */
    dshBinPath: string;
    /** Pino log level. */
    logLevel: string;
    /** Set the `Secure` flag on session cookies (enable behind HTTPS). */
    secureCookies: boolean;
    /** Session lifetime in seconds. */
    sessionTtlSeconds: number;
}
/** Untyped overrides collected from argv / env. */
export interface ConfigOverrides {
    host?: string;
    port?: string | number;
    dbPath?: string;
    dataRoot?: string;
    dshBinPath?: string;
    logLevel?: string;
    secureCookies?: boolean;
    sessionTtlSeconds?: number | string;
}
/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh-server-login` (always writable for dev); production sets
 * `DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login`.
 */
export declare function resolveConfig(overrides?: ConfigOverrides): ServerConfig;
