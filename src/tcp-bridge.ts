/**
 * Tiny TCP bridge: listen on one address and forward every connection to
 * another. Replaces the `alpine/socat` sidecar in the per-user DSH Pod, so the
 * Pod no longer depends on a docker.io image (blocked on ACK, docs/k8s-deploy.md
 * §7). Runs from the control-plane image's Node runtime.
 * @module dsh-server-login/tcp-bridge
 */

import { createConnection, createServer, type Server } from 'node:net'

/**
 * Start a TCP bridge: `listen` (e.g. `0.0.0.0:8081`) → `target`
 * (e.g. `127.0.0.1:8080`). Resolves when listening.
 */
export function startTcpBridge(listen: string, target: string): Promise<Server> {
  const [targetHost, targetPort] = splitHostPort(target)
  const server = createServer((socket) => {
    // A fresh outbound connection to the target — NOT `socket.connect`, which
    // would try to re-connect the already-connected inbound socket.
    const upstream = createConnection(Number(targetPort), targetHost)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  const [listenHost, listenPort] = splitHostPort(listen)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(listenPort), listenHost, () => resolve(server))
  })
}

/** `host:port` → `[host, port]`, defaulting the host to `0.0.0.0`. */
function splitHostPort(addr: string): [string, string] {
  const idx = addr.lastIndexOf(':')
  if (idx === -1) return ['0.0.0.0', addr]
  return [addr.slice(0, idx), addr.slice(idx + 1)]
}
