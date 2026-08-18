/**
 * cordis patch rendering for a folder's enabled plugins.
 *
 * Each catalog id doubles as the package name; the emitted patch inserts one
 * row per enabled plugin so the child DSH mounts it. The real harness loads
 * this via `--patch <file>`.
 * @module dsh-server-login/supervisor/patch
 */
/** Render a patch YAML enabling `enabledPlugins`; empty string when none. */
export declare function renderPatch(enabledPlugins: readonly string[]): string;
