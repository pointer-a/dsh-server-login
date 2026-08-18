/**
 * Per-user DSH supervisor: a main + watchdog process pair, crash detection,
 * auto-restart with backoff, diagnostics capture, and post-restart handoff.
 *
 * P5 implements the process-management half of the watchdog design: the
 * orchestrator spawns both processes, detects a crash, and restarts the main
 * with a bounded backoff while the watchdog (a headless DSH) carries out the
 * agent-level repair/session-resume — the harness-internal half, deferred to
 * real-harness integration (see docs/blueprint.md §4).
 * @module dsh-server-login/supervisor/orchestrator
 */
import type { ServerConfig } from '../config.js';
export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped';
export type InstanceRole = 'main' | 'watchdog';
/** A tracked child DSH (main or watchdog). */
export interface Instance {
    id: string;
    userId: string;
    role: InstanceRole;
    folder: string;
    port?: number;
    status: InstanceStatus;
    pid?: number;
    exitCode?: number;
    lastError?: string;
    patchPath?: string;
}
/** Thrown when a user already has a running main DSH. */
export declare class AlreadyRunningError extends Error {
    constructor(userId: string);
}
/** A user's main + watchdog pair. */
export interface UserStatus {
    main?: Instance;
    watchdog?: Instance;
}
/**
 * Owns the lifecycle of per-user DSH process pairs. State is in-memory.
 */
export declare class Supervisor {
    private readonly config;
    private readonly mains;
    private readonly watchdogs;
    private readonly children;
    private readonly restartTimers;
    constructor(config: ServerConfig);
    /** Spawn the watchdog + main pair for a user (main must not already exist). */
    launch(userId: string, folder: string, patchPath?: string): Promise<Instance>;
    /** Stop the current main (clean) and respawn it with the same folder/patch. */
    restartMain(userId: string): Promise<Instance | undefined>;
    /** Current main + watchdog for a user. */
    status(userId: string): UserStatus;
    /** Loopback port of the user's running main, if any. */
    portFor(userId: string): number | undefined;
    /** Stop both processes for a user (cancelling any pending restart). */
    stop(userId: string): void;
    /** Stop every tracked process on shutdown. */
    teardown(): void;
    private handoffPath;
    private baseEnv;
    private spawnInstance;
    private trackChild;
    private scheduleRestart;
    private killInstance;
}
