/**
 * Leader-only controller: reconciles the cluster against the desired state in
 * `dsh_instances` (docs/k8s.md §5.7) and watches the main DSH Pods for crashes.
 *
 * The k8s backend has no child-process `exit` event the way the local backend
 * does — a crashed Pod is observed either by the informer (here) or by the next
 * reconcile tick (a desired main whose Pod is gone). Both funnel into the same
 * repair path: mark the instance crashed, pull up the one-shot watchdog Job,
 * and let the reconcile relaunch the main if its Pod stays absent.
 * @module dsh-server-login/supervisor/reconcile
 */

import { makeInformer, type Informer } from '@kubernetes/client-node'
import type { DbAdapter } from '../db/adapter.js'
import type { DshInstance } from '../db/types.js'
import type { LeaderElector } from './leader.js'
import type { K8sSpawner } from './k8s-spawner.js'
import type { LivePod } from './spawner.js'

/** The result of diffing desired state against live Pods. Pure and testable. */
export interface ReconcilePlan {
  /** Desired mains whose Pod is missing → relaunch. */
  launch: DshInstance[]
  /** Live Pods with no desired row → delete (orphans). */
  delete: LivePod[]
}

/** Diff desired mains vs live Pods. */
export function planReconcile(desired: DshInstance[], live: LivePod[]): ReconcilePlan {
  const liveByUser = new Map(live.map((pod) => [pod.userId, pod]))
  const launch: DshInstance[] = []
  for (const instance of desired) {
    if (instance.role !== 'main') continue
    const pod = liveByUser.get(instance.userId)
    if (pod === undefined || !pod.running) launch.push(instance)
  }
  const desiredUsers = new Set(desired.filter((i) => i.role === 'main').map((i) => i.userId))
  const del = live.filter((pod) => !desiredUsers.has(pod.userId))
  return { launch, delete: del }
}

/** Loop that reconciles only while leader, plus a Pod informer for crashes. */
export class ReconcileController {
  private informer: Informer<object> | undefined
  private timer: NodeJS.Timeout | undefined
  private leading = false
  private readonly watchdogFired = new Set<string>()
  private readonly intervalMs: number

  constructor(
    private readonly db: DbAdapter,
    private readonly spawner: K8sSpawner,
    private readonly elector: LeaderElector,
    intervalMs = 10_000,
  ) {
    this.intervalMs = intervalMs
    elector.setLeadershipCallbacks(
      (fencing) => {
        this.leading = true
        this.spawner.setFencing(fencing)
        this.startInformer()
        this.scheduleTick(0)
      },
      () => {
        this.leading = false
        this.stopInformer()
      },
    )
  }

  async start(): Promise<void> {
    await this.elector.start()
  }

  stop(): void {
    this.elector.stop()
    this.stopInformer()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private startInformer(): void {
    if (this.informer !== undefined) return
    this.informer = this.spawner.watchMainPods((pod) => this.onPodEvent(pod))
    void this.informer.start().catch(() => {
      // The informer is best-effort; the reconcile tick still converges.
      this.informer = undefined
    })
  }

  private stopInformer(): void {
    void this.informer?.stop().catch(() => {})
    this.informer = undefined
  }

  private scheduleTick(delayMs: number): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.leading) return
      void this.tick().finally(() => this.scheduleTick(this.intervalMs))
    }, delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    const [desired, live] = await Promise.all([
      this.db.listInstancesByRole('main'),
      this.spawner.listUserPods(),
    ])
    const plan = planReconcile(desired, live)

    for (const orphan of plan.delete) {
      // Orphan = a main Pod with no desired row (user deleted or disabled).
      await this.safe(`orphan ${orphan.userId}`, async () => {
        await this.db.deleteInstance(orphan.name)
        await this.spawner.stop(orphan.userId)
      })
    }
    for (const instance of plan.launch) {
      await this.safe(`launch ${instance.userId}`, () =>
        this.spawner.launch(instance.userId, instance.folder ?? '', instance.patch ?? undefined))
    }
    // Recreate a lost Service/NetworkPolicy for any desired main that still has a Pod.
    for (const instance of desired) {
      if (plan.launch.includes(instance)) continue
      await this.safe(`ensure ${instance.userId}`, () => this.spawner.ensureUserResources(instance.userId))
    }
    // Idle reap (Phase 4): a desired main whose user has no active session has
    // outlived its session TTL — stop the Pod and drop the desired row so the
    // next tick does not relaunch it.
    for (const instance of desired) {
      await this.safe(`reap ${instance.userId}`, async () => {
        if (await this.db.hasActiveSession(instance.userId)) return
        await this.spawner.stop(instance.userId)
        await this.db.deleteInstance(instance.id)
      })
    }
  }

  /** Run one per-user step without letting its failure abort the rest of the tick. */
  private async safe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      // One bad user (e.g. a files Pod that can't become Ready) must not block
      // launches/idle-reap for every other user.
      this.spawner.logError?.(new Error(`reconcile ${label}: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private async onPodEvent(pod: LivePod): Promise<void> {
    if (!pod.crashed || !pod.running) {
      // A healthy transition clears the "already fired" guard so a later crash
      // triggers the watchdog again.
      if (pod.running && !pod.crashed) this.watchdogFired.delete(pod.userId)
      return
    }
    if (this.watchdogFired.has(pod.userId)) return
    this.watchdogFired.add(pod.userId)
    try {
      await this.spawner.spawnWatchdog(pod.userId)
    } catch (err) {
      this.watchdogFired.delete(pod.userId)
      this.spawner.logError?.(err)
    }
  }
}
