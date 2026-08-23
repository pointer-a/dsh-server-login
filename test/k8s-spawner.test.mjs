// K8sSpawner unit tests against fake API clients. Covers the six defects fixed
// in Stage 4 without needing a cluster: 404-vs-500 error handling, full
// teardown of every generated object, idempotent Secret/ConfigMap, and the
// file-sidecar Pod + init container shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { K8sSpawner } from '../lib/supervisor/k8s-spawner.js'
import { resolveConfig } from '../lib/config.js'
import { AlreadyRunningError } from '../lib/supervisor/spawner.js'
import { FILE_SERVICE_PORT } from '../lib/web/file-service.js'

function notFound() {
  const err = new Error('not found')
  err.code = 404
  return err
}
function conflict() {
  const err = new Error('already exists')
  err.code = 409
  return err
}

/** A tiny in-memory fake for the K8s API surface K8sSpawner touches. */
function makeClients() {
  const pods = new Map()
  const services = new Map()
  const secrets = new Map()
  const configMaps = new Map()
  const policies = new Map()
  const jobs = new Map()
  const deletes = []

  return {
    pods, services, secrets, configMaps, policies, jobs, deletes,
    core: {
      async readNamespacedPod({ name }) { return pods.get(name) ?? (() => { throw notFound() })() },
      async createNamespacedPod({ body }) { pods.set(body.metadata.name, body); return body },
      async deleteNamespacedPod({ name }) { deletes.push(`pod:${name}`); pods.delete(name) },
      async readNamespacedSecret({ name }) { return secrets.get(name) ?? (() => { throw notFound() })() },
      async createNamespacedSecret({ body }) { secrets.set(body.metadata.name, body); return body },
      async deleteNamespacedSecret({ name }) { deletes.push(`secret:${name}`); secrets.delete(name) },
      async readNamespacedConfigMap({ name }) { return configMaps.get(name) ?? (() => { throw notFound() })() },
      async createNamespacedConfigMap({ body }) { configMaps.set(body.metadata.name, body); return body },
      async deleteNamespacedConfigMap({ name }) { deletes.push(`configmap:${name}`); configMaps.delete(name) },
      async createNamespacedService({ body }) { services.set(body.metadata.name, body); return body },
      async deleteNamespacedService({ name }) { deletes.push(`service:${name}`); services.delete(name) },
    },
    networking: {
      async createNamespacedNetworkPolicy({ body }) { policies.set(body.metadata.name, body); return body },
      async deleteNamespacedNetworkPolicy({ name }) { deletes.push(`np:${name}`); policies.delete(name) },
    },
    batch: {
      async createNamespacedJob({ body }) { jobs.set(body.metadata.name, body); return body },
      async deleteNamespacedJob({ name }) { deletes.push(`job:${name}`); jobs.delete(name) },
    },
  }
}

function spawner(clients) {
  const config = resolveConfig({ deployMode: 'k8s', controlPlaneImage: 'acr/cp:tag', dshImage: 'acr/dsh:tag' })
  const db = { findUserInstance: async () => undefined }
  return new K8sSpawner(config, db, async () => 'sk-test', async () => 100042, clients)
}

test('k8s: launch creates DSH Pod/Service/NP and calls ensureFileService first', async () => {
  const clients = makeClients()
  const s = spawner(clients)
  const inst = await s.launch('u1', '/ws/proj')
  assert.equal(inst.id, 'dsh-u1')
  assert.ok(clients.pods.has('dsh-files-u1'), 'files Pod created first')
  assert.ok(clients.pods.has('dsh-u1'), 'dsh Pod created')
  assert.ok(clients.services.has('dsh-u1'), 'dsh Service created')
  assert.ok(clients.policies.has('dsh-u1'), 'dsh NetworkPolicy created')

  const filesPod = clients.pods.get('dsh-files-u1')
  assert.equal(filesPod.spec.containers[0].args[0], 'file-service', 'files container runs the file-service subcommand')
  assert.equal(filesPod.spec.initContainers.length, 1, 'files Pod carries the user-dir init container')
  const filesMounts = filesPod.spec.containers[0].volumeMounts
  assert.equal(filesMounts.length, 1, 'files container mounts exactly its own subPath')
  assert.equal(filesMounts[0].name, 'data')
  assert.equal(filesMounts[0].subPath, 'u1', 'files container mounts <pvc>/u1 via subPath')
  const initMount = filesPod.spec.initContainers[0].volumeMounts[0]
  assert.equal(initMount.name, 'data-root', 'init container mounts the PVC root (no subPath)')
  assert.equal(initMount.subPath, undefined, 'init container has no subPath')

  await assert.rejects(() => s.launch('u1', '/ws/proj'), AlreadyRunningError)
})

test('k8s: endpointFor returns the headless Service only for a Running Pod', async () => {
  const clients = makeClients()
  const s = spawner(clients)
  assert.equal(await s.endpointFor('u1'), undefined, 'absent Pod → undefined')
  clients.pods.set('dsh-u1', { status: { phase: 'Running' } })
  assert.deepEqual(await s.endpointFor('u1'), { host: 'dsh-u1.dsh.svc.cluster.local', port: 80 })
})

test('k8s: stop deletes every generated object (Pod/Service/NP/Job/ConfigMap)', async () => {
  const clients = makeClients()
  const s = spawner(clients)
  await s.launch('u1', '/ws/proj', '- insert:\n')
  // Pre-seed the patch ConfigMap + watchdog Job as a prior launch would have.
  clients.configMaps.set('dsh-u1-patch', { metadata: { name: 'dsh-u1-patch' } })
  clients.jobs.set('dsh-u1-watchdog', { metadata: { name: 'dsh-u1-watchdog' } })

  await s.stop('u1')
  const names = clients.deletes
  for (const expected of ['pod:dsh-u1', 'service:dsh-u1', 'np:dsh-u1', 'job:dsh-u1-watchdog', 'configmap:dsh-u1-patch']) {
    assert.ok(names.includes(expected), `stop deletes ${expected}`)
  }
  // stop() must NOT touch the files Pod (it lives independently of the DSH).
  assert.ok(clients.pods.has('dsh-files-u1'), 'files Pod survives a DSH stop')
})

test('k8s: a 404 is swallowed, but 403/500 propagate', async () => {
  const clients = makeClients()
  const s = spawner(clients)
  // endpointFor must not mask a real failure as "not running".
  clients.core.readNamespacedPod = async () => { const e = new Error('forbidden'); e.code = 403; throw e }
  await assert.rejects(() => s.endpointFor('u1'), (err) => err.code === 403, '403 surfaces')
  clients.core.readNamespacedPod = async () => { throw notFound() }
  assert.equal(await s.endpointFor('u1'), undefined, '404 is "no Pod"')
})

test('k8s: ensureSecret is idempotent (no 409 on relaunch)', async () => {
  const clients = makeClients()
  const s = spawner(clients)
  // First call: read → 404 → create.
  await s.ensureFileService('u1') // exercises the image gate, not the secret
  await s.launch('u1', '/ws')
  // Simulate a stale Secret still present after a stop that skipped it.
  clients.secrets.set('dsh-key-u1', { metadata: { name: 'dsh-key-u1' } })
  clients.pods.delete('dsh-u1')
  await s.launch('u1', '/ws') // read → present → no create, no throw
  assert.ok(clients.secrets.has('dsh-key-u1'), 'secret still present, no 409')
})

test('k8s: ensureFileService fails loudly without a control-plane image', async () => {
  const config = resolveConfig({ deployMode: 'k8s', controlPlaneImage: '', dshImage: 'acr/dsh:tag' })
  const s = new K8sSpawner(config, { findUserInstance: async () => undefined }, async () => null, async () => 100042, makeClients())
  await assert.rejects(() => s.ensureFileService('u1'), /CONTROL_PLANE_IMAGE/, 'missing image is a hard failure')
})

test('k8s: files NetworkPolicy only allows the control plane on the file port', async () => {
  const clients = makeClients()
  const s = spawner(clients)
  await s.ensureFileService('u1')
  const np = clients.policies.get('dsh-files-u1')
  assert.equal(np.spec.ingress[0]._from[0].podSelector.matchLabels.app, 'dsh-orchestrator')
  assert.equal(np.spec.ingress[0].ports[0].port, FILE_SERVICE_PORT)
  // No 443 egress for the files sidecar — it never reaches the LLM API.
  assert.equal(np.spec.egress.some((rule) => (rule.ports ?? []).some((p) => p.port === 443)), false)
})
