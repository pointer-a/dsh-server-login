/**
 * cordis patch rendering for a child DSH. Always mounts the runtime plugin
 * (`dsh-server-login/runtime`) so every child injects the watchdog contract,
 * plus one row per enabled folder plugin (id doubles as package name). The real
 * harness loads this via `--patch <file>`.
 * @module dsh-server-login/supervisor/patch
 */
/** The runtime plugin patch row, mounted in every child DSH. */
const RUNTIME_ROW = '    - id: dsh-server-login-runtime\n      name: dsh-server-login/runtime';
/** Render a patch YAML always enabling the runtime plugin plus `enabledPlugins`. */
export function renderPatch(enabledPlugins) {
    const rows = [RUNTIME_ROW, ...enabledPlugins.map((id) => `    - id: ${id}\n      name: ${id}`)];
    return `- insert:\n${rows.join('\n')}\n`;
}
//# sourceMappingURL=patch.js.map