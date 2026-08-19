/**
 * Per-user plugin discovery: read the resident DSH profile's `dsh.profile.bundles`
 * and surface user-installed bundles, filtering out installation-owned
 * `@deepseek-ai/*` bundles. Name/description come from each bundle's own
 * package.json.
 * @module dsh-server-login/fs/plugins
 */
import type { ServerConfig } from '../config.js';
/** A plugin the user may enable per folder (`id` doubles as the package name). */
export interface PluginInfo {
    id: string;
    name: string;
    description: string;
}
/** Profile name the resident main DSH is launched with (see supervisor). */
export declare const MAIN_PROFILE = "web";
/**
 * List a user's installed plugins from their profile's `dsh.profile.bundles`,
 * minus installation-owned bundles. Returns `[]` when the profile (or a listed
 * package) has not been installed yet. Order follows the bundle layer order.
 */
export declare function listInstalledPlugins(config: ServerConfig, userId: string): PluginInfo[];
