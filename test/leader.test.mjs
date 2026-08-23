// Leader election + reconcile planning, without a cluster. `planReconcile` is
// pure; `LeaderElector` is driven through a fake CoordinationV1Api and a fake
// clock so the acquire / back-off / take-over state machine is deterministic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LeaderElector } from '../lib/supervisor/leader.js'
import { planReconcile } from '../lib/supervisor/reconcile.js'

// The real client deserializes V1MicroTime back to an ISO *string*, so fake the
// same shape here to exercise the normalize-on-read path.
const lease = (holder, renewMs, transitions = 0, rv = '1') => ({
  metadata: { resourceVersion: rv },
  spec: {
    holderIdentity: holder,
    renewTime: new Date(renewMs).toISOString(),
    leaseTransitions: transitions,
  },
})

test('reconcile: relaunch desired mains with a missing/stopped Pod, delete orphans', () => {
  const desired = [
    { id: 'dsh-a', userId: 'a', role: 'main', folder: '/ws', patch: null },
    { id: 'dsh-b', userId: 'b', role: 'main', folder: '/ws', patch: null },
  ]
  const live = [
    { name: 'dsh-a', userId: 'a', running: true, crashed: false },
    { name: 'dsh-orphan', userId: 'x', running: true, crashed: false },
  ]
  const plan = planReconcile(desired, live)
  assert.deepEqual(plan.launch.map((i) => i.userId), ['b'], 'missing main is relaunched')
  assert.deepEqual(plan.delete.map((p) => p.userId), ['x'], 'orphan Pod is deleted')
})

test('reconcile: a crashed (non-running) Pod still counts as absent', () => {
  const plan = planReconcile(
    [{ id: 'dsh-a', userId: 'a', role: 'main', folder: '/ws', patch: null }],
    [{ name: 'dsh-a', userId: 'a', running: false, crashed: true }],
  )
  assert.equal(plan.launch.length, 1, 'crashed Pod → relaunch')
  assert.equal(plan.delete.length, 0)
})

test('leader: first candidate creates the lease and leads', async () => {
  let created = false
  let patched = []
  const coordination = {
    async createNamespacedLease({ body }) {
      created = true
      return body
    },
    async readNamespacedLease() { throw Object.assign(new Error('nf'), { code: 404 }) },
    async replaceNamespacedLease({ body }) { patched.push(body) },
  }
  const started = []
  const elector = new LeaderElector({ namespace: 'dsh', identity: 'pod-1', coordination, now: () => 1_000_000 })
  elector.setLeadershipCallbacks((f) => started.push(f))
  await elector.start()
  assert.equal(created, true, 'first candidate creates the lease')
  assert.equal(elector.isLeader, true)
  assert.equal(started[0].holder, 'pod-1')
  assert.equal(started[0].operationId, 0)
  elector.stop()
})

test('leader: a second candidate backs off while a live holder leads', async () => {
  const coordination = {
    async createNamespacedLease() { throw Object.assign(new Error('exists'), { code: 409 }) },
    async readNamespacedLease() { return lease('pod-1', 10_000_000) }, // renew 1s ago, live
    async replaceNamespacedLease() { throw new Error('should not replace') },
  }
  const elector = new LeaderElector({
    namespace: 'dsh',
    identity: 'pod-2',
    coordination,
    now: () => 11_000_000, // 1s after the holder's renew, still within 15s
  })
  await elector.start()
  assert.equal(elector.isLeader, false, 'live holder → back off')
  elector.stop()
})

test('leader: a stale lease is taken over with a bumped transition', async () => {
  let patched
  const coordination = {
    async createNamespacedLease() { throw Object.assign(new Error('exists'), { code: 409 }) },
    async readNamespacedLease() { return lease('pod-1', 10_000_000, 3, 'rv-9') }, // renew 20s ago, expired
    async replaceNamespacedLease({ body }) { patched = body },
  }
  const started = []
  const elector = new LeaderElector({
    namespace: 'dsh',
    identity: 'pod-2',
    coordination,
    now: () => 30_000_000,
  })
  elector.setLeadershipCallbacks((f) => started.push(f))
  await elector.start()
  assert.equal(elector.isLeader, true, 'expired lease → take over')
  assert.equal(patched.metadata.resourceVersion, 'rv-9', 'CAS on the read resourceVersion')
  assert.equal(patched.spec.leaseTransitions, 4, 'transition bumps')
  assert.equal(started[0].operationId, 4, 'fencing token carries the new transition')
  elector.stop()
})

test('leader: re-acquiring our own lease renews rather than bumps', async () => {
  let patched
  const coordination = {
    async createNamespacedLease() { throw Object.assign(new Error('exists'), { code: 409 }) },
    async readNamespacedLease() { return lease('pod-1', 30_000_000, 0, 'rv-2') },
    async replaceNamespacedLease({ body }) { patched = body },
  }
  const elector = new LeaderElector({ namespace: 'dsh', identity: 'pod-1', coordination, now: () => 30_000_000 })
  await elector.start()
  assert.equal(elector.isLeader, true)
  assert.equal(patched.spec.leaseTransitions, 0, 'renewing preserves transitions (does not bump)')
  elector.stop()
})
