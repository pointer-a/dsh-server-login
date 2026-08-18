/**
 * Per-user DSH supervisor: main + watchdog process pair, health, teardown.
 *
 * Skeleton — P3 implements single-DSH launch + loopback port tracking + stop;
 * P5 implements the crash-takeover loop (diagnose → repair session log via
 * `interruptedTurnClosers`/`session-persistence` → repair root cause → resume).
 * @module dsh-server-login/supervisor/orchestrator
 */
/**
 * Owns the lifecycle of all per-user DSH processes. State is a stub; the real
 * implementation persists into `dsh_instances` and drives spawn/kill/watch.
 */
export class Supervisor {
    config;
    instances = new Map();
    constructor(config) {
        this.config = config;
    }
    /** Build the per-role spawn spec for a user's workspace. (P3) */
    buildSpec(_userId, _workspaceId, _role) {
        throw new Error('Supervisor.buildSpec not implemented until P3');
    }
    /** Spawn and track a child DSH. (P3) */
    launch(_spec) {
        throw new Error('Supervisor.launch not implemented until P3');
    }
    /** Stop a tracked instance with tree teardown. (P3) */
    stop(_id) {
        throw new Error('Supervisor.stop not implemented until P3');
    }
    /** Teardown every tracked process on shutdown. */
    async teardown() {
        this.instances.clear();
    }
}
//# sourceMappingURL=orchestrator.js.map