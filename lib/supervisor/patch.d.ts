/**
 * cordis patch rendering for a child DSH. Always mounts the runtime plugin
 * (`dsh-server-login/runtime`) so every child injects the watchdog contract,
 * plus one row per enabled folder plugin (id doubles as package name). The real
 * harness loads this via `--patch <file>`.
 * @module dsh-server-login/supervisor/patch
 */
/** Render a patch YAML always enabling the runtime plugin plus `enabledPlugins`. */
export declare function renderPatch(enabledPlugins: readonly string[]): string;
