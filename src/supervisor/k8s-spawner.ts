/**
 * K8s backend for per-user DSH lifecycle (docs/k8s.md §5.2/§4.3/§4.4/§4.8).
 *
 * Each user gets a `dsh-<userId>` Pod (dsh + socat sidecar), a Headless Service,
 * a NetworkPolicy, and a `dsh-key-<userId>` Secret for the API key. A crash
 * pulls up a one-shot `dsh-<userId>-watchdog` Job. The control plane runs
 * in-cluster and talks to the K8s API via @kubernetes/client-node.
 * @module dsh-server-login/supervisor/k8s-spawner
 */

import * as k8s from '@kubernetes/client-node'
import type { ServerConfig } from '../config.js'
import type { DbAdapter } from '../db/adapter.js'
import { HANDOFF_FILE, HOME_DIR, USERS_DIR, WORKSPACE_DIR } from '../fs/workspace.js'
import { FILE_SERVICE_PORT, USER_ROOT_ENV } from '../web/file-service.js'
import type { Fencing } from './leader.js'
import { AlreadyRunningError, type Endpoint, type Instance, type LivePod, type Spawner, type UserStatus } from './spawner.js'

/** Loopback port the dsh container binds; the socat sidecar bridges 8081 → 8080. */
const DSH_LOOPBACK_PORT = 8080
/** Sidecar bridge port the per-user Service targets (80 → 8081). */
const SOCAT_PORT = 8081
/** Task the one-shot headless watchdog runs (executes the handoff command). */
const WATCHDOG_TASK = 'Read DSH_SERVER_LOGIN_HANDOFF_PATH. If it contains a JSON {"command": ...}, run that command. Then exit.'
/** Shared RWX PVC every user's Pod mounts via subPath. */
const USERS_PVC = 'dsh-users'

/** Per-user resource names (deterministic — idempotent create). */
function names(userId: string) {
  return {
    pod: `dsh-${userId}`,
    service: `dsh-${userId}`,
    networkPolicy: `dsh-${userId}`,
    secret: `dsh-key-${userId}`,
    job: `dsh-${userId}-watchdog`,
    patch: `dsh-${userId}-patch`,
    filesPod: `dsh-files-${userId}`,
    filesService: `dsh-files-${userId}`,
    filesNetworkPolicy: `dsh-files-${userId}`,
  }
}

/** The data root inside every per-user Pod, independent of the control plane's
 * own `dataRoot` (which under k8s points at a volume the Pod never sees). */
const POD_DATA_ROOT = '/var/lib/dsh-server-login'

/** Home/workspace paths inside the DSH Pod (docs/k8s.md §4.3). Built with
 * POSIX separators — the control plane may be developed/tested on Windows. */
function userPaths(userId: string): { home: string; ws: string; mount: string } {
  const mount = `${POD_DATA_ROOT}/${USERS_DIR}/${userId}`
  return { home: `${mount}/${HOME_DIR}`, ws: `${mount}/${WORKSPACE_DIR}`, mount }
}

/** Pod-safe labels shared by the DSH Pod/Service/NetworkPolicy/Job. */
function podLabels(userId: string): { app: string; user: string } {
  return { app: 'dsh', user: userId }
}

/** Labels for the per-user file sidecar (a distinct `app`, so its own
 * Service/NetworkPolicy select it without touching the DSH Pod). */
function filesLabels(userId: string): { app: string; user: string } {
  return { app: 'dsh-files', user: userId }
}

/** API-key env entry, omitted when the user has no key. */
function apiKeyEnv(userId: string, apiKey: string | null): k8s.V1EnvVar[] {
  if (apiKey === null) return []
  return [{ name: 'DEEPSEEK_API_KEY', valueFrom: { secretKeyRef: { name: names(userId).secret, key: 'key' } } }]
}

/** Common per-user container security context (non-root + drop ALL + seccomp). */
function containerSecurity(uid: number): k8s.V1SecurityContext {
  return {
    runAsNonRoot: true,
    runAsUser: uid,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    seccompProfile: { type: 'RuntimeDefault' },
  }
}

/** The shared RWX volume (subPath mounts per-user at use time). */
function dataVolume(): k8s.V1Volume[] {
  return [{ name: 'data', persistentVolumeClaim: { claimName: USERS_PVC } }]
}

/** The shared RWX volume mounted at its **root** (no subPath) so an init
 * container can create/chown `<pvc>/<userId>` as the user's own uid. */
function dataRootVolume(): k8s.V1Volume[] {
  return [{ name: 'data-root', persistentVolumeClaim: { claimName: USERS_PVC } }]
}

/** Every per-user Pod/Job references ACR private images, so each must carry the
 * cluster's pull secret (the control-plane Deployment has it in its manifest,
 * but generated Pods don't inherit it). */
function pullSecrets(name: string): k8s.V1LocalObjectReference[] {
  return name === '' ? [] : [{ name }]
}

/** Fencing labels stamped onto resources created by the leader, so a successor
 * can identify work a dead leader left in flight (docs/k8s.md §5.3). */
function stampFencing(labels: Record<string, string>, fencing: Fencing | undefined): void {
  if (fencing === undefined) return
  labels['dsh.io/holder'] = fencing.holder
  labels['dsh.io/operation-id'] = String(fencing.operationId)
}

/**
 * K8s backend implementing {@link Spawner}. State lives in the cluster; every
 * method is a K8s API call (or a read).
 */
export class K8sSpawner implements Spawner {
  private readonly core: k8s.CoreV1Api
  private readonly networking: k8s.NetworkingV1Api
  private readonly batch: k8s.BatchV1Api
  private readonly namespace: string
  private readonly kc: k8s.KubeConfig
  private fencing: Fencing | undefined

  constructor(
    private readonly config: ServerConfig,
    private readonly db: DbAdapter,
    private readonly resolveApiKey: (userId: string) => Promise<string | null>,
    private readonly resolveUid: (userId: string) => Promise<number>,
    clients?: { core: k8s.CoreV1Api; networking: k8s.NetworkingV1Api; batch: k8s.BatchV1Api },
  ) {
    // Injecting clients short-circuits cluster auth (used by tests). Otherwise
    // build them from the in-cluster config, which needs a mounted SA token.
    const kc = new k8s.KubeConfig()
    if (clients === undefined) {
      kc.loadFromCluster()
      clients = {
        core: kc.makeApiClient(k8s.CoreV1Api),
        networking: kc.makeApiClient(k8s.NetworkingV1Api),
        batch: kc.makeApiClient(k8s.BatchV1Api),
      }
    }
    this.kc = kc
    this.core = clients.core
    this.networking = clients.networking
    this.batch = clients.batch
    this.namespace = config.k8sNamespace
  }

  async launch(userId: string, folder: string, patch?: string): Promise<Instance> {
    const n = names(userId)
    if (await this.podExists(n.pod)) throw new AlreadyRunningError(userId)
    await this.ensureFileService(userId) // the DSH Pod's subPath must already exist
    const apiKey = await this.resolveApiKey(userId)
    const uid = await this.resolveUid(userId)
    const hasPatch = this.config.enablePatch && patch !== undefined
    if (hasPatch) await this.ensurePatchConfigMap(n.patch, patch)
    await this.ensureSecret(n.secret, apiKey)
    await this.ensurePod(n.pod, userId, uid, apiKey, hasPatch ? n.patch : undefined)
    await this.ensureService(n.service, userId)
    await this.ensureNetworkPolicy(n.networkPolicy, userId)
    try {
      await this.db.upsertInstance({ id: n.pod, userId, role: 'main', status: 'starting', folder, patch })
    } catch (err) {
      this.logError(err) // reconcile needs this row; don't fail the launch over it
    }
    return { id: n.pod, userId, role: 'main', folder, status: 'starting', patch }
  }

  async restartMain(userId: string): Promise<Instance | undefined> {
    const desired = await this.db.findUserInstance(userId, 'main')
    if (desired === undefined) return undefined
    await this.stop(userId)
    return await this.launch(userId, desired.folder ?? '', desired.patch ?? undefined)
  }

  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    const n = names(userId)
    const apiKey = await this.resolveApiKey(userId)
    const uid = await this.resolveUid(userId)
    const { home, ws, mount } = userPaths(userId)
    const jobLabels = podLabels(userId)
    const podTemplateLabels = podLabels(userId)
    stampFencing(jobLabels, this.fencing)
    stampFencing(podTemplateLabels, this.fencing)
    await this.batch.createNamespacedJob({ namespace: this.namespace, body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: n.job, namespace: this.namespace, labels: jobLabels },
      spec: {
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: { labels: podTemplateLabels },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: pullSecrets(this.config.imagePullSecret),
            restartPolicy: 'Never',
            securityContext: {
              runAsNonRoot: true,
              runAsUser: uid,
              fsGroup: uid,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'dsh',
                image: this.config.dshImage,
                args: ['--profile', 'headless', WATCHDOG_TASK],
                env: [
                  { name: 'HOME', value: ws },
                  { name: 'DSH_HOME', value: home },
                  { name: 'DSH_SERVER_LOGIN_ROLE', value: 'watchdog' },
                  { name: 'DSH_SERVER_LOGIN_HANDOFF_PATH', value: `${mount}/${HANDOFF_FILE}` },
                  ...apiKeyEnv(userId, apiKey),
                ],
                volumeMounts: [{ name: 'data', mountPath: mount, subPath: userId }],
                securityContext: containerSecurity(uid),
              },
            ],
            volumes: dataVolume(),
          },
        },
      },
    } })
    return { id: n.job, userId, role: 'watchdog', folder: ws, status: 'starting' }
  }

  async status(userId: string): Promise<UserStatus> {
    return { main: await this.readInstance(names(userId).pod, userId, 'main') }
  }

  async endpointFor(userId: string): Promise<Endpoint | undefined> {
    let pod: k8s.V1Pod
    try {
      pod = await this.core.readNamespacedPod({ name: names(userId).pod, namespace: this.namespace })
    } catch (err) {
      if (this.isNotFound(err)) return undefined
      throw err // 403/500 are real failures, not "not running"
    }
    if (pod.status?.phase !== 'Running') return undefined
    return { host: `${names(userId).service}.${this.namespace}.svc.cluster.local`, port: 80 }
  }

  async stop(userId: string): Promise<void> {
    const n = names(userId)
    await this.ignoreNotFound(() => this.core.deleteNamespacedPod({ name: n.pod, namespace: this.namespace }))
    await this.ignoreNotFound(() => this.core.deleteNamespacedService({ name: n.service, namespace: this.namespace }))
    await this.ignoreNotFound(() => this.networking.deleteNamespacedNetworkPolicy({ name: n.networkPolicy, namespace: this.namespace }))
    await this.ignoreNotFound(() => this.batch.deleteNamespacedJob({ name: n.job, namespace: this.namespace }))
    await this.ignoreNotFound(() => this.core.deleteNamespacedConfigMap({ name: n.patch, namespace: this.namespace }))
    try {
      await this.db.deleteInstance(n.pod) // desired state is gone once stopped
    } catch (err) {
      this.logError(err)
    }
  }

  /** No-op: per-user Pods outlive any single control-plane replica (reconcile/leader manages them). */
  async teardown(): Promise<void> {}

  /** Bring up the user's file sidecar (docs/k8s.md §4.10). The sidecar is a
   * distinct always-on Pod so the desktop is usable *before* the on-demand DSH
   * launches; its init container creates the user's subPath directory. */
  async ensureFileService(userId: string): Promise<void> {
    if (this.config.controlPlaneImage === '') {
      throw new Error('DSH_SERVER_LOGIN_CONTROL_PLANE_IMAGE is required in k8s mode (file sidecar image)')
    }
    const n = names(userId)
    const uid = await this.resolveUid(userId)
    await this.ensureFilesPod(n.filesPod, userId, uid)
    await this.ensureFilesService(n.filesService, userId)
    await this.ensureFilesNetworkPolicy(n.filesNetworkPolicy, userId)
    // The Headless Service only publishes an A record once the Pod is Ready;
    // the caller resolves it immediately, so block until it comes up.
    await this.waitForPodReady(n.filesPod)
  }

  // --- reconcile / watch support (leader-only callers) ---

  /** Stamp the current leader's fencing token onto resources created from now on. */
  setFencing(fencing: Fencing | undefined): void {
    this.fencing = fencing
  }

  /** Main DSH Pods (`app=dsh`), mapped to the shape the controller needs. */
  async listUserPods(): Promise<LivePod[]> {
    const res = await this.core.listNamespacedPod({ namespace: this.namespace, labelSelector: 'app=dsh' })
    return (res.items ?? []).map((pod) => {
      const phase = pod.status?.phase ?? ''
      return {
        name: pod.metadata?.name ?? '',
        userId: pod.metadata?.labels?.user ?? '',
        running: phase === 'Running',
        crashed: phase === 'Failed' || phase === 'Succeeded',
      }
    })
  }

  /** Recreate a lost Service/NetworkPolicy for a user whose main Pod exists. */
  async ensureUserResources(userId: string): Promise<void> {
    await this.ensureService(names(userId).service, userId)
    await this.ensureNetworkPolicy(names(userId).networkPolicy, userId)
  }

  /** Watch main DSH Pods; `callback` fires on add/update/delete with their state. */
  watchMainPods(callback: (pod: LivePod) => void): k8s.Informer<k8s.V1Pod> & k8s.ObjectCache<k8s.V1Pod> {
    const informer = k8s.makeInformer<k8s.V1Pod>(
      this.kc,
      `/api/v1/namespaces/${this.namespace}/pods`,
      () => this.core.listNamespacedPod({ namespace: this.namespace, labelSelector: 'app=dsh' }),
      'app=dsh',
    )
    const emit = (obj: k8s.V1Pod | undefined): void => {
      const phase = obj?.status?.phase ?? ''
      callback({
        name: obj?.metadata?.name ?? '',
        userId: obj?.metadata?.labels?.user ?? '',
        running: phase === 'Running',
        crashed: phase === 'Failed' || phase === 'Succeeded',
      })
    }
    informer.on('add', (obj) => emit(obj))
    informer.on('update', (obj) => emit(obj))
    informer.on('delete', (obj) => emit(obj))
    return informer
  }

  /** Best-effort error surface for the controller's tick loop. */
  logError(err: unknown): void {
    console.error('[dsh-reconcile]', err)
  }

  // --- helpers ---

  private async podExists(name: string): Promise<boolean> {
    try {
      await this.core.readNamespacedPod({ name, namespace: this.namespace })
      return true
    } catch (err) {
      if (this.isNotFound(err)) return false
      throw err // 403/500 are real failures, not "no Pod"
    }
  }

  private async readInstance(name: string, userId: string, role: 'main' | 'watchdog'): Promise<Instance | undefined> {
    try {
      const pod = await this.core.readNamespacedPod({ name, namespace: this.namespace })
      const status = pod.status?.phase === 'Running' ? 'running' : pod.status?.phase === 'Failed' ? 'crashed' : 'starting'
      return { id: name, userId, role, folder: '', status }
    } catch (err) {
      if (this.isNotFound(err)) return undefined
      throw err
    }
  }

  /** Create-or-replace, so a relaunch after `stop()` (which deletes these) can
   * never 409 on a stale Secret/ConfigMap from a prior launch. */
  private async ensureSecret(name: string, apiKey: string | null): Promise<void> {
    if (apiKey === null) return
    await this.replace({
      read: () => this.core.readNamespacedSecret({ name, namespace: this.namespace }),
      create: () => this.core.createNamespacedSecret({ namespace: this.namespace, body: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name, namespace: this.namespace },
        type: 'Opaque',
        stringData: { key: apiKey },
      } }),
      del: () => this.core.deleteNamespacedSecret({ name, namespace: this.namespace }),
    })
  }

  /** Create-or-replace a generated resource. Reads first for the cheap path,
   * then treats a 409 race by deleting and recreating (we own every resource
   * this helper touches, so replacement is safe). */
  private async replace(ops: {
    read: () => Promise<unknown>
    create: () => Promise<unknown>
    del: () => Promise<unknown>
  }): Promise<void> {
    try {
      await ops.read()
    } catch (err) {
      if (!this.isNotFound(err)) throw err
      try {
        await ops.create()
      } catch (createErr) {
        if (!this.isConflict(createErr)) throw createErr
        await this.ignoreNotFound(ops.del)
        await ops.create()
      }
    }
  }

  private async ensurePod(name: string, userId: string, uid: number, apiKey: string | null, patchConfigMapName?: string): Promise<void> {
    const { home, ws, mount } = userPaths(userId)
    const args = ['--profile', 'web', '--host', '127.0.0.1', '--port', String(DSH_LOOPBACK_PORT)]
    // The runtime plugin (dsh-server-login/runtime) is baked into the dsh image
    // but loaded via --patch; the rendered patch is mounted at /etc/dsh/patch.yml.
    if (patchConfigMapName !== undefined) args.splice(1, 0, '--patch', '/etc/dsh/patch.yml')
    const labels = podLabels(userId)
    stampFencing(labels, this.fencing)
    await this.core.createNamespacedPod({ namespace: this.namespace, body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace: this.namespace, labels },
      spec: {
        automountServiceAccountToken: false,
        imagePullSecrets: pullSecrets(this.config.imagePullSecret),
        hostNetwork: false,
        hostPID: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: uid,
          fsGroup: uid,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'dsh',
            image: this.config.dshImage,
            args,
            readinessProbe: { tcpSocket: { port: DSH_LOOPBACK_PORT }, initialDelaySeconds: 5, periodSeconds: 3 },
            env: [
              { name: 'HOME', value: ws },
              { name: 'DSH_HOME', value: home },
              ...apiKeyEnv(userId, apiKey),
            ],
            volumeMounts: [
              { name: 'data', mountPath: mount, subPath: userId },
              ...(patchConfigMapName !== undefined ? [{ name: 'patch', mountPath: '/etc/dsh', readOnly: true }] : []),
            ],
            securityContext: containerSecurity(uid),
            resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } },
          },
          {
            name: 'sidecar',
            image: this.config.controlPlaneImage,
            args: ['tcp-bridge', `0.0.0.0:${SOCAT_PORT}`, `127.0.0.1:${DSH_LOOPBACK_PORT}`],
            ports: [{ containerPort: SOCAT_PORT }],
            securityContext: containerSecurity(uid),
            resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '100m', memory: '128Mi' } },
          },
        ],
        volumes: [
          ...dataVolume(),
          ...(patchConfigMapName !== undefined ? [{ name: 'patch', configMap: { name: patchConfigMapName } }] : []),
        ],
      },
    } })
  }

  private async ensurePatchConfigMap(name: string, patch: string): Promise<void> {
    await this.replace({
      read: () => this.core.readNamespacedConfigMap({ name, namespace: this.namespace }),
      create: () => this.core.createNamespacedConfigMap({ namespace: this.namespace, body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace: this.namespace },
        data: { 'patch.yml': patch },
      } }),
      del: () => this.core.deleteNamespacedConfigMap({ name, namespace: this.namespace }),
    })
  }

  private async ensureService(name: string, userId: string): Promise<void> {
    await this.replace({
      read: () => this.core.readNamespacedService({ name, namespace: this.namespace }),
      create: () => this.core.createNamespacedService({ namespace: this.namespace, body: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace: this.namespace },
        spec: {
          clusterIP: 'None', // Headless: no ClusterIP, DNS A record → Pod IP
          selector: podLabels(userId),
          ports: [{ port: 80, targetPort: SOCAT_PORT }],
        },
      } }),
      del: () => this.core.deleteNamespacedService({ name, namespace: this.namespace }),
    })
  }

  private async ensureNetworkPolicy(name: string, userId: string): Promise<void> {
    await this.replace({
      read: () => this.networking.readNamespacedNetworkPolicy({ name, namespace: this.namespace }),
      create: () => this.networking.createNamespacedNetworkPolicy({ namespace: this.namespace, body: {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name, namespace: this.namespace },
        spec: {
          podSelector: { matchLabels: podLabels(userId) },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [{ _from: [{ podSelector: { matchLabels: { app: 'dsh-orchestrator' } } }] }],
          egress: [
            {
              to: [{ namespaceSelector: {}, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
              ports: [
                { port: 53, protocol: 'UDP' },
                { port: 53, protocol: 'TCP' },
              ],
            },
            {
              to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] } }],
              ports: [{ port: 443 }],
            },
          ],
        },
      } }),
      del: () => this.networking.deleteNamespacedNetworkPolicy({ name, namespace: this.namespace }),
    })
  }

  private async ensureFilesPod(name: string, userId: string, uid: number): Promise<void> {
    const mount = userPaths(userId).mount
    await this.replace({
      read: () => this.core.readNamespacedPod({ name, namespace: this.namespace }),
      create: () => this.core.createNamespacedPod({ namespace: this.namespace, body: {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, namespace: this.namespace, labels: filesLabels(userId) },
        spec: {
          automountServiceAccountToken: false,
          imagePullSecrets: pullSecrets(this.config.imagePullSecret),
          hostNetwork: false,
          hostPID: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: uid,
            fsGroup: uid,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          // Creates `<pvc>/<userId>/{ws,home}` as the user's uid (docs/k8s.md
          // §4.9). Runs on the PVC *root* (no subPath), because the subPath dir
          // may not exist yet or be root-owned; the user's 0700 dir keeps other
          // users' files out of reach.
          initContainers: [
            {
              name: 'init-user',
              image: this.config.controlPlaneImage,
              command: ['sh', '-ec', `mkdir -p /mnt/${userId}/${WORKSPACE_DIR} /mnt/${userId}/${HOME_DIR} && chmod 0700 /mnt/${userId}`],
              volumeMounts: [{ name: 'data-root', mountPath: '/mnt' }],
              securityContext: containerSecurity(uid),
            },
          ],
          containers: [
            {
              name: 'files',
              image: this.config.controlPlaneImage,
              args: ['file-service'],
              env: [{ name: USER_ROOT_ENV, value: mount }],
              ports: [{ containerPort: FILE_SERVICE_PORT }],
              readinessProbe: { tcpSocket: { port: FILE_SERVICE_PORT }, initialDelaySeconds: 2, periodSeconds: 3 },
              volumeMounts: [{ name: 'data', mountPath: mount, subPath: userId }],
              securityContext: containerSecurity(uid),
              resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '200m', memory: '256Mi' } },
            },
          ],
          volumes: [...dataVolume(), ...dataRootVolume()],
        },
      } }),
      del: () => this.core.deleteNamespacedPod({ name, namespace: this.namespace }),
    })
  }

  private async ensureFilesService(name: string, userId: string): Promise<void> {
    await this.replace({
      read: () => this.core.readNamespacedService({ name, namespace: this.namespace }),
      create: () => this.core.createNamespacedService({ namespace: this.namespace, body: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace: this.namespace },
        spec: {
          clusterIP: 'None',
          selector: filesLabels(userId),
          ports: [{ port: FILE_SERVICE_PORT, targetPort: FILE_SERVICE_PORT }],
        },
      } }),
      del: () => this.core.deleteNamespacedService({ name, namespace: this.namespace }),
    })
  }

  private async ensureFilesNetworkPolicy(name: string, userId: string): Promise<void> {
    await this.replace({
      read: () => this.networking.readNamespacedNetworkPolicy({ name, namespace: this.namespace }),
      create: () => this.networking.createNamespacedNetworkPolicy({ namespace: this.namespace, body: {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name, namespace: this.namespace },
        spec: {
          podSelector: { matchLabels: filesLabels(userId) },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [{ _from: [{ podSelector: { matchLabels: { app: 'dsh-orchestrator' } } }], ports: [{ port: FILE_SERVICE_PORT }] }],
          // Files only; the sidecar never talks to the LLM API.
          egress: [
            {
              to: [{ namespaceSelector: {}, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
              ports: [
                { port: 53, protocol: 'UDP' },
                { port: 53, protocol: 'TCP' },
              ],
            },
          ],
        },
      } }),
      del: () => this.networking.deleteNamespacedNetworkPolicy({ name, namespace: this.namespace }),
    })
  }

  /** Poll until a Pod's Ready condition is true, or fail after `timeoutMs`. */
  private async waitForPodReady(name: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pod = await this.core.readNamespacedPod({ name, namespace: this.namespace })
      const ready = pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
      if (ready) return
      if (Date.now() >= deadline) throw new Error(`Pod ${name} not ready within ${timeoutMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private isNotFound(err: unknown): boolean {
    return (err as { code?: number }).code === 404
  }

  private isConflict(err: unknown): boolean {
    return (err as { code?: number }).code === 409
  }

  private async ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      // `@kubernetes/client-node` throws `ApiException` with a `code` field.
      if (this.isNotFound(err)) return
      throw err
    }
  }
}
