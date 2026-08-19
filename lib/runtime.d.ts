/**
 * Runtime plugin loaded into each child DSH (mounted by the patch the
 * orchestrator generates). It is part of THIS bundle (not a harness change) and
 * reads the env contract set at spawn time:
 *
 *   DSH_SERVER_LOGIN_PORT          — loopback port the web server must bind (main)
 *   DSH_SERVER_LOGIN_ROLE          — 'main' | 'watchdog'
 *   DSH_SERVER_LOGIN_HANDOFF_PATH  — post-restart command handoff file (both roles)
 *   DSH_SERVER_LOGIN_WORKSPACE     — absolute folder the user launched from (main)
 *   DSH_HOME / DEEPSEEK_API_KEY    — per-user home + platform key
 *
 * On the MAIN role it also registers a system-prompt section that tells the
 * agent about the watchdog DSH and the restart contract: on a needed restart
 * (e.g. after a plugin install) the agent writes the post-restart command to
 * the handoff path, and the orchestrator pulls up a one-shot watchdog to
 * execute it after the main respawns.
 * @module dsh-server-login/runtime
 */
export declare const name = "dsh-server-login-runtime";
/** The `ctx.systemPrompt.section()` contract this plugin needs (structural). */
export interface PromptSection {
    name: string;
    order: number;
    text: string | ((context: unknown) => string);
}
export interface RuntimeEnv {
    role: 'main' | 'watchdog';
    port?: number;
    handoffPath?: string;
    workspace?: string;
}
/** Parse the env contract set by the orchestrator. */
export declare function readRuntimeEnv(env?: NodeJS.ProcessEnv): RuntimeEnv;
/** Prompt text telling the main agent about the watchdog + restart contract. */
export declare function watchdogPrompt(handoffPath?: string): string;
/** The section contributed by this plugin; exported for tests. */
export declare function watchdogSection(runtime: RuntimeEnv): PromptSection;
/**
 * Cordis entry. Logs the resolved env, and on the main role registers the
 * watchdog-contract system-prompt section.
 * @param ctx - the Cordis context.
 */
export declare function apply(ctx: {
    systemPrompt?: {
        section(section: PromptSection): () => void;
    };
    on?: (event: string, fn: () => void) => void;
    workspaceRegistry?: {
        create(path: string, title?: string): unknown;
    };
}): void;
