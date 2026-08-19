/**
 * Deployment-varying configuration. Every tunable is a validated field here
 * (or read from env), never a hardcoded constant inside the app.
 * @module dsh-server-login/config
 */
/** Isolation tier. `soft` = per-user home/workspace + sandbox (same OS user);
 * `account` = per-user OS account via a setuid wrapper (Linux, needs root). */
export type IsolationMode = 'soft' | 'account';
/** A plugin available for per-folder enablement (`id` = package name). */
export interface PluginInfo {
    id: string;
    name: string;
    description: string;
}
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
    /** Argv used to launch a child DSH; first element is the executable. */
    dshCommand: string[];
    /** Catalog of plugins users may enable per folder. */
    availablePlugins: PluginInfo[];
    /** Pino log level. */
    logLevel: string;
    /** Set the `Secure` flag on session cookies (enable behind HTTPS). */
    secureCookies: boolean;
    /** Session lifetime in seconds. */
    sessionTtlSeconds: number;
    /** Max upload request body in bytes (base64 JSON; ~0.75× the file size). */
    maxUploadBytes: number;
    /** Delay before auto-restarting a crashed child DSH, in milliseconds. */
    restartBackoffMs: number;
    /** Isolation tier (see {@link IsolationMode}). */
    isolationMode: IsolationMode;
    /** Argv prefix that drops privileges; `{UID}`/`{GID}` are substituted. */
    spawnAsUserCommand: string[];
    /** Base uid for the deterministic per-user uid. */
    baseUid: number;
    /** Parent domain for per-user subdomains (`<username>.<baseDomain>`); empty = disabled. */
    baseDomain: string;
    /** Cookie `Domain` value (e.g. `.example.com`) so the session reaches subdomains; empty = host-only. */
    cookieDomain: string;
    /** Whether to pass `--patch` to child DSHs (needs a dsh CLI that supports it). */
    enablePatch: boolean;
}
/** Untyped overrides collected from argv / env. */
export interface ConfigOverrides {
    host?: string;
    port?: string | number;
    dbPath?: string;
    dataRoot?: string;
    dshCommand?: string[];
    availablePlugins?: PluginInfo[];
    logLevel?: string;
    secureCookies?: boolean;
    sessionTtlSeconds?: number | string;
    maxUploadBytes?: number | string;
    restartBackoffMs?: number | string;
    isolationMode?: IsolationMode;
    spawnAsUserCommand?: string[];
    baseUid?: number | string;
    baseDomain?: string;
    cookieDomain?: string;
    enablePatch?: boolean;
}
/**
 * Fold argv/env overrides over defaults. `dataRoot` defaults to
 * `~/.dsh-server-login` (always writable for dev); production sets
 * `DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login`.
 */
export declare function resolveConfig(overrides?: ConfigOverrides): ServerConfig;
