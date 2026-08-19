/**
 * Runtime plugin loaded into each child DSH (mounted by the patch the
 * orchestrator generates). It is part of THIS bundle (not a harness change) and
 * reads the env contract set at spawn time:
 *
 *   DSH_SERVER_LOGIN_PORT          — loopback port the web server must bind (main)
 *   DSH_SERVER_LOGIN_ROLE          — 'main' | 'watchdog'
 *   DSH_SERVER_LOGIN_HANDOFF_PATH  — post-restart command handoff file (both roles)
 *   DSH_HOME / DEEPSEEK_API_KEY    — per-user home + platform key
 *
 * On the MAIN role it also registers a system-prompt section that tells the
 * agent about the watchdog DSH and the restart contract: on a needed restart
 * (e.g. after a plugin install) the agent writes the post-restart command to
 * the handoff path, and the orchestrator pulls up a one-shot watchdog to
 * execute it after the main respawns.
 * @module dsh-server-login/runtime
 */
export const name = 'dsh-server-login-runtime';
/** Parse the env contract set by the orchestrator. */
export function readRuntimeEnv(env = process.env) {
    const role = env.DSH_SERVER_LOGIN_ROLE === 'watchdog' ? 'watchdog' : 'main';
    const port = Number(env.DSH_SERVER_LOGIN_PORT ?? '');
    const handoffPath = env.DSH_SERVER_LOGIN_HANDOFF_PATH;
    return {
        role,
        ...(Number.isFinite(port) && port > 0 ? { port } : {}),
        ...(handoffPath !== undefined && handoffPath !== '' ? { handoffPath } : {}),
    };
}
/** Prompt text telling the main agent about the watchdog + restart contract. */
export function watchdogPrompt(handoffPath) {
    const handoffLine = handoffPath !== undefined
        ? `当需要重启时：先把「重启后要自动执行的命令」写入 handoff 文件 \`${handoffPath}\`（JSON：\`{"command":"..."}\`），再触发重启；守护 DSH 会在重启后读取并执行它。`
        : '当需要重启时：先给出「重启后要自动执行的命令」，再触发重启；守护 DSH 会在重启后执行它。';
    return [
        '你由 dsh-server-login 托管，是主 DSH 实例，系统中存在一个「守护 DSH」搭档，职责：',
        '1. 崩溃接管：若你崩溃，守护 DSH 会被拉起，修复会话日志并恢复同一会话续接对话，然后重启主实例。',
        '2. 重启执行：当你需要重启（例如安装或更新插件之后）时，守护 DSH 负责在重启后执行你给出的命令。',
        handoffLine,
    ].join('\n');
}
/** The section contributed by this plugin; exported for tests. */
export function watchdogSection(runtime) {
    return {
        name: 'dsh-server-login/watchdog',
        order: 100,
        text: watchdogPrompt(runtime.handoffPath),
    };
}
/**
 * Cordis entry. Logs the resolved env, and on the main role registers the
 * watchdog-contract system-prompt section.
 * @param ctx - the Cordis context.
 */
export function apply(ctx) {
    const runtime = readRuntimeEnv();
    // eslint-disable-next-line no-console
    console.log(`[dsh-server-login-runtime] role=${runtime.role} port=${runtime.port ?? ''} handoff=${runtime.handoffPath ?? ''}`);
    if (runtime.role === 'main' && ctx.systemPrompt !== undefined) {
        const dispose = ctx.systemPrompt.section(watchdogSection(runtime));
        ctx.on?.('dispose', dispose);
    }
}
//# sourceMappingURL=runtime.js.map