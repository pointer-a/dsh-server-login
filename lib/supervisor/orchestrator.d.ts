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
    /** Resolve the user's own API key (decrypted); null = user has none. */
    private readonly resolveApiKey;
    private readonly mains;
    private readonly watchdogs;
    private readonly children;
    private readonly restartTimers;
    constructor(config: ServerConfig, 
    /** Resolve the user's own API key (decrypted); null = user has none. */
    resolveApiKey: (userId: string) => string | null);
    /** Spawn the resident main DSH for a user (watchdog is pulled up on demand). */
    launch(userId: string, folder: string, patchPath?: string): Promise<Instance>;
    /** Stop the current main (clean) and respawn it with the same folder/patch. */
    restartMain(userId: string): Promise<Instance | undefined>;
    /** Spawn a one-shot watchdog for the user's current main (repair / execute). */
    spawnWatchdog(userId: string): Promise<Instance | undefined>;
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
    /** Spawn the child, optionally through the account-level setuid wrapper. */
    private spawnAsUser;
    private trackChild;
    private scheduleRestart;
    private killInstance;
}
