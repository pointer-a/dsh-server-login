/**
 * Hand-rolled leader election over `coordination.k8s.io/v1` Lease
 * (docs/k8s.md §5.3). `@kubernetes/client-node` ships no election helper, so
 * this holds the small state machine: try to create the lease, and when it
 * already exists either renew (we hold it) or take it over only after the
 * holder's renew time has exceeded `leaseDurationSeconds`.
 *
 * Timings follow the doc's anti-split-brain ordering
 * `LeaseDuration > RenewDeadline > RetryPeriod`.
 * @module dsh-server-login/supervisor/leader
 */

import * as k8s from '@kubernetes/client-node'
import { hostname } from 'node:os'

/** The fencing token a controller stamps onto resources it creates. */
export interface Fencing {
  holder: string
  operationId: number
}

export interface LeaderOptions {
  identity?: string
  leaseName?: string
  namespace: string
  leaseDurationSeconds?: number
  renewDeadlineSeconds?: number
  retryPeriodSeconds?: number
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number
  onStartedLeading?: (fencing: Fencing) => void
  onStoppedLeading?: () => void
  /** Injectable lease client (tests); defaults to the in-cluster config. */
  coordination?: k8s.CoordinationV1Api
}

/** `@kubernetes/client-node` deserializes `V1MicroTime` back to an ISO string,
 * not a Date — `renewTime.getTime()` would throw. Normalize either shape. */
function toMillis(time: unknown): number {
  if (time === undefined || time === null) return 0
  if (typeof time === 'string') {
    const ms = Date.parse(time)
    return Number.isNaN(ms) ? 0 : ms
  }
  if (time instanceof Date) return time.getTime()
  return 0
}

/** Normalize a read-back `V1MicroTime` (string) back to a Date for the replace body. */
function toMicroTime(time: unknown): k8s.V1MicroTime | undefined {
  const ms = toMillis(time)
  return ms > 0 ? new k8s.V1MicroTime(ms) : undefined
}

/** Acquire/keep a Lease, notifying callers across leadership changes. */
export class LeaderElector {
  private readonly coordination: k8s.CoordinationV1Api
  private readonly identity: string
  private readonly leaseName: string
  private readonly namespace: string
  private readonly leaseDurationSeconds: number
  private readonly renewDeadlineSeconds: number
  private readonly retryPeriodSeconds: number
  private readonly now: () => number
  private onStartedLeading?: (fencing: Fencing) => void
  private onStoppedLeading?: () => void

  private leading = false
  private operationId = 0
  private lastRenew = 0
  private timer: NodeJS.Timeout | undefined

  constructor(options: LeaderOptions) {
    if (options.coordination !== undefined) {
      this.coordination = options.coordination
    } else {
      const kc = new k8s.KubeConfig()
      kc.loadFromCluster()
      this.coordination = kc.makeApiClient(k8s.CoordinationV1Api)
    }
    this.identity = options.identity ?? process.env.POD_NAME ?? hostname()
    this.leaseName = options.leaseName ?? 'dsh-orchestrator'
    this.namespace = options.namespace
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 15
    this.renewDeadlineSeconds = options.renewDeadlineSeconds ?? 10
    this.retryPeriodSeconds = options.retryPeriodSeconds ?? 2
    this.now = options.now ?? Date.now
    this.onStartedLeading = options.onStartedLeading
    this.onStoppedLeading = options.onStoppedLeading
  }

  get isLeader(): boolean {
    return this.leading
  }

  /** Wire (or rewire) leadership callbacks. The controller owns the reaction,
   * not the elector, so it attaches itself here. */
  setLeadershipCallbacks(onStarted?: (fencing: Fencing) => void, onStopped?: () => void): void {
    this.onStartedLeading = onStarted
    this.onStoppedLeading = onStopped
  }

  /** The current fencing token (valid only while {@link isLeader}). */
  get fencing(): Fencing {
    return { holder: this.identity, operationId: this.operationId }
  }

  /** Start the acquire/renew loop. Resolves once started (does not wait for leadership). */
  async start(): Promise<void> {
    if (this.timer !== undefined) return
    await this.tryAcquire()
  }

  /** Stop the loop and yield leadership if held. */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.leading) {
      this.leading = false
      this.onStoppedLeading?.()
    }
  }

  /** One acquire/renew round, rescheduling itself with retry/backoff. */
  private async tryAcquire(): Promise<void> {
    try {
      if (this.leading) {
        await this.renew()
      } else {
        await this.acquire()
      }
    } catch {
      // Transient API/network failure: retry. Leadership is only lost after the
      // renewDeadline elapses without a successful renew, checked in the loop.
    }
    this.scheduleNext()
  }

  private scheduleNext(): void {
    if (this.timer !== undefined) return
    // When leader, renew well inside renewDeadline; otherwise back off and retry.
    const delay = this.leading ? Math.min(this.renewDeadlineSeconds / 2, this.retryPeriodSeconds) : this.retryPeriodSeconds
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.leading && this.now() - this.lastRenew > this.renewDeadlineSeconds * 1000) {
        // Too long without a successful renew → another holder may have taken over.
        this.leading = false
        this.onStoppedLeading?.()
      }
      void this.tryAcquire()
    }, delay * 1000)
    this.timer.unref?.()
  }

  private lease(now: number, transitions: number): k8s.V1Lease {
    return {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: this.leaseName, namespace: this.namespace },
      spec: {
        holderIdentity: this.identity,
        leaseDurationSeconds: this.leaseDurationSeconds,
        acquireTime: new k8s.V1MicroTime(now),
        renewTime: new k8s.V1MicroTime(now),
        leaseTransitions: transitions,
      },
    }
  }

  private async acquire(): Promise<void> {
    try {
      await this.coordination.createNamespacedLease({
        namespace: this.namespace,
        body: this.lease(this.now(), 0),
      })
      this.becomeLeader(0, this.now())
    } catch (err) {
      if ((err as { code?: number }).code !== 409) throw err
      // Lease exists — take over only if the holder's renew time is stale.
      const current = await this.coordination.readNamespacedLease({
        name: this.leaseName,
        namespace: this.namespace,
      })
      const holder = current.spec?.holderIdentity
      const renew = toMillis(current.spec?.renewTime)
      if (holder === this.identity) {
        // We already hold it (e.g. after a restart) — renew, then resume leading.
        await this.renew()
        this.becomeLeader(current.spec?.leaseTransitions ?? 0, this.now())
        return
      }
      const expired = this.now() - renew > this.leaseDurationSeconds * 1000
      if (!expired) return // a live leader holds it; back off
      const transitions = (current.spec?.leaseTransitions ?? 0) + 1
      const now = this.now()
      // `patchNamespacedLease` uses JSON Patch (an array); a full replace with a
      // resourceVersion gives the optimistic-concurrency takeover we want.
      await this.coordination.replaceNamespacedLease({
        name: this.leaseName,
        namespace: this.namespace,
        body: {
          apiVersion: 'coordination.k8s.io/v1',
          kind: 'Lease',
          metadata: { name: this.leaseName, namespace: this.namespace, resourceVersion: current.metadata?.resourceVersion },
          spec: {
            holderIdentity: this.identity,
            leaseDurationSeconds: this.leaseDurationSeconds,
            acquireTime: new k8s.V1MicroTime(now),
            renewTime: new k8s.V1MicroTime(now),
            leaseTransitions: transitions,
          },
        },
      })
      this.becomeLeader(transitions, now)
    }
  }

  private async renew(): Promise<void> {
    const now = this.now()
    // Always read the latest lease so we preserve holder/acquireTime/transitions
    // and bump only renewTime.
    const current = await this.coordination.readNamespacedLease({
      name: this.leaseName,
      namespace: this.namespace,
    })
    await this.coordination.replaceNamespacedLease({
      name: this.leaseName,
      namespace: this.namespace,
      body: {
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: this.leaseName, namespace: this.namespace, resourceVersion: current.metadata?.resourceVersion },
        spec: {
          holderIdentity: current.spec?.holderIdentity ?? this.identity,
          leaseDurationSeconds: this.leaseDurationSeconds,
          acquireTime: toMicroTime(current.spec?.acquireTime),
          renewTime: new k8s.V1MicroTime(now),
          leaseTransitions: current.spec?.leaseTransitions ?? 0,
        },
      },
    })
    this.lastRenew = now
  }

  private becomeLeader(operationId: number, now: number): void {
    const wasLeader = this.leading
    this.leading = true
    this.operationId = operationId
    this.lastRenew = now
    if (!wasLeader) this.onStartedLeading?.({ holder: this.identity, operationId })
  }
}
