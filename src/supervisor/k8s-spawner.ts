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
import { HANDOFF_FILE, HOME_DIR, USERS_DIR, WORKSPACE_DIR } from '../fs/workspace.js'
import { AlreadyRunningError, type Endpoint, type Instance, type Spawner, type UserStatus } from './spawner.js'

/** Loopback port the dsh container binds; the socat sidecar bridges 8081 → 8080. */
const DSH_LOOPBACK_PORT = 8080
/** Sidecar bridge port the per-user Service targets (80 → 8081). */
const SOCAT_PORT = 8081
/** Task the one-shot headless watchdog runs (executes the handoff command). */
const WATCHDOG_TASK = 'Read DSH_SERVER_LOGIN_HANDOFF_PATH. If it contains a JSON {"command": ...}, run that command. Then exit.'
/** Shared RWX PVC every user's Pod mounts via subPath. */
const USERS_PVC = 'dsh-users'

/** Per-user resource names (deterministic — idempotent create). */
function names(userId: string): { pod: string; service: string; networkPolicy: string; secret: string; job: string; patch: string } {
  return {
    pod: `dsh-${userId}`,
    service: `dsh-${userId}`,
    networkPolicy: `dsh-${userId}`,
    secret: `dsh-key-${userId}`,
    job: `dsh-${userId}-watchdog`,
    patch: `dsh-${userId}-patch`,
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

/** Pod-safe labels shared by Pod/Service/NetworkPolicy/Job. */
function podLabels(userId: string): { app: string; user: string } {
  return { app: 'dsh', user: userId }
}

/** API-key env entry, omitted when the user has no key. */
function apiKeyEnv(namespace: string, userId: string, apiKey: string | null): k8s.V1EnvVar[] {
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

/**
 * K8s backend implementing {@link Spawner}. State lives in the cluster; every
 * method is a K8s API call (or a read).
 */
export class K8sSpawner implements Spawner {
  private readonly core: k8s.CoreV1Api
  private readonly networking: k8s.NetworkingV1Api
  private readonly batch: k8s.BatchV1Api
  private readonly namespace: string

  constructor(
    private readonly config: ServerConfig,
    private readonly resolveApiKey: (userId: string) => Promise<string | null>,
    private readonly resolveUid: (userId: string) => Promise<number>,
  ) {
    const kc = new k8s.KubeConfig()
    kc.loadFromCluster()
    this.core = kc.makeApiClient(k8s.CoreV1Api)
    this.networking = kc.makeApiClient(k8s.NetworkingV1Api)
    this.batch = kc.makeApiClient(k8s.BatchV1Api)
    this.namespace = config.k8sNamespace
  }

  async launch(userId: string, folder: string, patch?: string): Promise<Instance> {
    const n = names(userId)
    if (await this.podExists(n.pod)) throw new AlreadyRunningError(userId)
    const apiKey = await this.resolveApiKey(userId)
    const uid = await this.resolveUid(userId)
    const hasPatch = this.config.enablePatch && patch !== undefined
    if (hasPatch) await this.ensurePatchConfigMap(n.patch, patch)
    await this.ensureSecret(n.secret, apiKey)
    await this.ensurePod(n.pod, userId, uid, apiKey, hasPatch ? n.patch : undefined)
    await this.ensureService(n.service, userId)
    await this.ensureNetworkPolicy(n.networkPolicy, userId)
    return { id: n.pod, userId, role: 'main', folder, status: 'starting', patch }
  }

  async restartMain(userId: string): Promise<Instance | undefined> {
    const existing = await this.readInstance(names(userId).pod, userId, 'main')
    if (existing === undefined) return undefined
    await this.stop(userId)
    return await this.launch(userId, existing.folder, existing.patch)
  }

  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    const n = names(userId)
    const apiKey = await this.resolveApiKey(userId)
    const uid = await this.resolveUid(userId)
    const { home, ws, mount } = userPaths(userId)
    await this.batch.createNamespacedJob({ namespace: this.namespace, body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: n.job, namespace: this.namespace, labels: podLabels(userId) },
      spec: {
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: { labels: podLabels(userId) },
          spec: {
            automountServiceAccountToken: false,
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
                  ...apiKeyEnv(this.namespace, userId, apiKey),
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
    try {
      const pod = await this.core.readNamespacedPod({ name: names(userId).pod, namespace: this.namespace })
      if (pod.status?.phase !== 'Running') return undefined
      return { host: `${names(userId).service}.${this.namespace}.svc.cluster.local`, port: 80 }
    } catch {
      return undefined // Pod not found → not running
    }
  }

  async stop(userId: string): Promise<void> {
    const n = names(userId)
    await this.ignoreNotFound(() => this.core.deleteNamespacedPod({ name: n.pod, namespace: this.namespace }))
    await this.ignoreNotFound(() => this.core.deleteNamespacedService({ name: n.service, namespace: this.namespace }))
    await this.ignoreNotFound(() => this.networking.deleteNamespacedNetworkPolicy({ name: n.networkPolicy, namespace: this.namespace }))
  }

  /** No-op: per-user Pods outlive any single control-plane replica (reconcile/leader manages them). */
  async teardown(): Promise<void> {}

  /** Bring up the user's file sidecar (docs/k8s.md §4.10). Implemented in the
   * next stage; declared here so the {@link Spawner} seam is complete. */
  async ensureFileService(_userId: string): Promise<void> {}

  // --- helpers ---

  private async podExists(name: string): Promise<boolean> {
    try {
      await this.core.readNamespacedPod({ name, namespace: this.namespace })
      return true
    } catch {
      return false
    }
  }

  private async readInstance(name: string, userId: string, role: 'main' | 'watchdog'): Promise<Instance | undefined> {
    try {
      const pod = await this.core.readNamespacedPod({ name, namespace: this.namespace })
      const status = pod.status?.phase === 'Running' ? 'running' : pod.status?.phase === 'Failed' ? 'crashed' : 'starting'
      return { id: name, userId, role, folder: '', status }
    } catch {
      return undefined
    }
  }

  private async ensureSecret(name: string, apiKey: string | null): Promise<void> {
    if (apiKey === null) return
    await this.core.createNamespacedSecret({ namespace: this.namespace, body: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace: this.namespace },
      type: 'Opaque',
      stringData: { key: apiKey },
    } })
  }

  private async ensurePod(name: string, userId: string, uid: number, apiKey: string | null, patchConfigMapName?: string): Promise<void> {
    const { home, ws, mount } = userPaths(userId)
    const args = ['--profile', 'web', '--host', '127.0.0.1', '--port', String(DSH_LOOPBACK_PORT)]
    // The runtime plugin (dsh-server-login/runtime) is baked into the dsh image
    // but loaded via --patch; the rendered patch is mounted at /etc/dsh/patch.yml.
    if (patchConfigMapName !== undefined) args.splice(1, 0, '--patch', '/etc/dsh/patch.yml')
    await this.core.createNamespacedPod({ namespace: this.namespace, body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace: this.namespace, labels: podLabels(userId) },
      spec: {
        automountServiceAccountToken: false,
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
              ...apiKeyEnv(this.namespace, userId, apiKey),
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
            image: 'alpine/socat:1.8.0.0',
            args: [`TCP-LISTEN:${SOCAT_PORT},fork,reuseaddr`, `TCP:127.0.0.1:${DSH_LOOPBACK_PORT}`],
            ports: [{ containerPort: SOCAT_PORT }],
            securityContext: containerSecurity(uid),
            resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
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
    await this.core.createNamespacedConfigMap({ namespace: this.namespace, body: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace: this.namespace },
      data: { 'patch.yml': patch },
    } })
  }

  private async ensureService(name: string, userId: string): Promise<void> {
    await this.core.createNamespacedService({ namespace: this.namespace, body: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: this.namespace },
      spec: {
        clusterIP: 'None', // Headless: no ClusterIP, DNS A record → Pod IP
        selector: podLabels(userId),
        ports: [{ port: 80, targetPort: SOCAT_PORT }],
      },
    } })
  }

  private async ensureNetworkPolicy(name: string, userId: string): Promise<void> {
    await this.networking.createNamespacedNetworkPolicy({ namespace: this.namespace, body: {
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
    } })
  }

  private async ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      // K8s API 404 → already gone; surface anything else.
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404) return
      throw e
    }
  }
}
