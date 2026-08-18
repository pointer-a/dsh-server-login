/**
 * Per-user DSH supervisor: a resident main DSH plus an **on-demand** watchdog.
 *
 * The watchdog is not spawned at launch; it is pulled up once when the main
 * crashes (to repair) or when a post-restart command must be executed. This
 * keeps the steady-state footprint at one process per active user while still
 * providing crash repair + command handoff. The watchdog's agent-level
 * repair/session-resume is harness-internal and deferred to real-harness
 * integration (see docs/blueprint.md §4).
 * @module dsh-server-login/supervisor/orchestrator
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { uidForUser } from '../isolation.js';
import { findFreePort, scrubEnv } from './spawn.js';
/** Thrown when a user already has a running main DSH. */
export class AlreadyRunningError extends Error {
    constructor(userId) {
        super(`user ${userId} already has a running DSH`);
        this.name = 'AlreadyRunningError';
    }
}
/**
 * Owns the lifecycle of per-user DSH process pairs. State is in-memory.
 */
export class Supervisor {
    config;
    mains = new Map();
    watchdogs = new Map();
    children = new Map();
    restartTimers = new Map();
    constructor(config) {
        this.config = config;
    }
    /** Spawn the resident main DSH for a user (watchdog is pulled up on demand). */
    async launch(userId, folder, patchPath) {
        if (this.mains.has(userId))
            throw new AlreadyRunningError(userId);
        return await this.spawnInstance(userId, 'main', folder, patchPath);
    }
    /** Stop the current main (clean) and respawn it with the same folder/patch. */
    async restartMain(userId) {
        const current = this.mains.get(userId);
        if (current === undefined)
            return undefined;
        this.killInstance(userId, current);
        return await this.spawnInstance(userId, 'main', current.folder, current.patchPath);
    }
    /** Spawn a one-shot watchdog for the user's current main (repair / execute). */
    async spawnWatchdog(userId) {
        if (this.watchdogs.has(userId))
            return this.watchdogs.get(userId);
        const main = this.mains.get(userId);
        if (main === undefined)
            return undefined;
        return await this.spawnInstance(userId, 'watchdog', main.folder);
    }
    /** Current main + watchdog for a user. */
    status(userId) {
        return { main: this.mains.get(userId), watchdog: this.watchdogs.get(userId) };
    }
    /** Loopback port of the user's running main, if any. */
    portFor(userId) {
        return this.mains.get(userId)?.port;
    }
    /** Stop both processes for a user (cancelling any pending restart). */
    stop(userId) {
        const timer = this.restartTimers.get(userId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.restartTimers.delete(userId);
        }
        const main = this.mains.get(userId);
        const watchdog = this.watchdogs.get(userId);
        if (main !== undefined)
            this.killInstance(userId, main);
        if (watchdog !== undefined)
            this.killInstance(userId, watchdog);
        this.mains.delete(userId);
        this.watchdogs.delete(userId);
    }
    /** Stop every tracked process on shutdown. */
    teardown() {
        for (const userId of [...this.mains.keys(), ...this.watchdogs.keys()])
            this.stop(userId);
    }
    handoffPath(userId) {
        return join(this.config.dataRoot, 'users', userId, 'handoff.json');
    }
    baseEnv(userId) {
        return {
            ...scrubEnv(process.env),
            DSH_HOME: join(this.config.dataRoot, 'users', userId, 'home'),
            DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
        };
    }
    async spawnInstance(userId, role, folder, patchPath) {
        const port = role === 'main' ? await findFreePort() : undefined;
        const instance = {
            id: randomUUID(),
            userId,
            role,
            folder,
            port,
            status: 'starting',
            patchPath,
        };
        const map = role === 'main' ? this.mains : this.watchdogs;
        map.set(userId, instance);
        const [command = 'dsh', ...args] = this.config.dshCommand;
        const launchArgs = ['--profile', role === 'main' ? 'web' : 'headless'];
        if (role === 'main')
            launchArgs.push('--host', '127.0.0.1', '--port', String(port));
        if (role === 'main' && patchPath !== undefined)
            launchArgs.push('--patch', patchPath);
        const env = { ...this.baseEnv(userId), DSH_SERVER_LOGIN_ROLE: role };
        if (role === 'main')
            env.DSH_SERVER_LOGIN_PORT = String(port);
        if (role === 'watchdog')
            env.DSH_SERVER_LOGIN_HANDOFF_PATH = this.handoffPath(userId);
        const child = this.spawnAsUser(userId, command, [...args, ...launchArgs], { cwd: folder, env });
        this.trackChild(userId, instance, child);
        return instance;
    }
    /** Spawn the child, optionally through the account-level setuid wrapper. */
    spawnAsUser(userId, command, args, options) {
        const stdio = ['ignore', 'pipe', 'pipe'];
        if (this.config.isolationMode !== 'account') {
            return spawn(command, args, { ...options, stdio });
        }
        const uid = uidForUser(userId, this.config.baseUid);
        const prefix = this.config.spawnAsUserCommand.map((part) => part.replaceAll('{UID}', String(uid)).replaceAll('{GID}', String(uid)));
        const [asCommand = 'setpriv', ...asArgs] = prefix;
        return spawn(asCommand, [...asArgs, command, ...args], { ...options, stdio });
    }
    trackChild(userId, instance, child) {
        this.children.set(instance.id, child);
        child.on('spawn', () => {
            instance.status = 'running';
            instance.pid = child.pid ?? undefined;
        });
        child.stdout?.pipe(process.stdout);
        let stderrTail = '';
        child.stderr?.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-2048);
        });
        child.on('error', (err) => {
            instance.status = 'crashed';
            instance.lastError = err.message;
            this.children.delete(instance.id);
        });
        child.on('exit', (code) => {
            instance.exitCode = code ?? undefined;
            this.children.delete(instance.id);
            const map = instance.role === 'main' ? this.mains : this.watchdogs;
            // Only act if this instance is still the current one (avoid a stale
            // exit handler touching a freshly restarted instance).
            if (map.get(userId)?.id !== instance.id)
                return;
            if (instance.status === 'stopped') {
                map.delete(userId);
                return;
            }
            // A one-shot watchdog that finished cleanly is not restarted.
            if (instance.role === 'watchdog' && code === 0) {
                instance.status = 'stopped';
                map.delete(userId);
                return;
            }
            instance.status = 'crashed';
            instance.lastError = stderrTail.slice(-500) || undefined;
            if (instance.role === 'main') {
                void this.spawnWatchdog(userId);
                this.scheduleRestart(userId, instance);
            }
            else {
                map.delete(userId);
            }
        });
    }
    scheduleRestart(userId, instance) {
        const timer = setTimeout(() => {
            this.restartTimers.delete(userId);
            void this.spawnInstance(userId, instance.role, instance.folder, instance.patchPath);
        }, this.config.restartBackoffMs);
        timer.unref();
        this.restartTimers.set(userId, timer);
    }
    killInstance(userId, instance) {
        instance.status = 'stopped';
        const child = this.children.get(instance.id);
        if (child === undefined)
            return;
        child.kill('SIGTERM');
        const killer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGKILL');
        }, 5000);
        killer.unref();
    }
}
//# sourceMappingURL=orchestrator.js.map