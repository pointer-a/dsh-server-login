/**
 * Per-user DSH supervisor: one main DSH per user, loopback port assignment,
 * status tracking, and tree teardown.
 *
 * P3 implements single-DSH launch/stop/status. P5 adds the watchdog/repair pair
 * (crash diagnosis → session-log repair → resume) on top of this lifecycle.
 * @module dsh-server-login/supervisor/orchestrator
 */
import type { ServerConfig } from '../config.js';
export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped';
/** A tracked child DSH (main). */
export interface Instance {
    id: string;
    userId: string;
    folder: string;
    port: number;
    status: InstanceStatus;
    pid?: number;
    exitCode?: number;
}
/** Thrown when a user already has a running main DSH. */
export declare class AlreadyRunningError extends Error {
    constructor(userId: string);
}
/**
 * Owns the lifecycle of all per-user DSH processes. State is in-memory (a
 * running instance dies with the orchestrator); DB reconciliation is a P3+
 * follow-up.
 */
export declare class Supervisor {
    private readonly config;
    private readonly instances;
    private readonly children;
    constructor(config: ServerConfig);
    /** Spawn a main DSH for `userId` rooted at the given workspace folder. */
    launch(userId: string, folder: string): Promise<Instance>;
    /** Current instance for a user, if any. */
    statusFor(userId: string): Instance | undefined;
    /** Loopback port of the user's running instance, if any. */
    portFor(userId: string): number | undefined;
    /** Stop a user's instance with SIGTERM, escalating to SIGKILL after a grace. */
    stop(userId: string): void;
    /** Stop every tracked instance on shutdown. */
    teardown(): void;
}
