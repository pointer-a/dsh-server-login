/**
 * nginx `server {}` rendering from the `domains` table. (P6)
 * @module dsh-server-login/nginx/generate
 */

/**
 * Render an nginx server block that terminates at the edge and proxies to the
 * orchestrator. Stub; P6 adds TLS cert paths + the `/u/<slug>/` rewrite.
 * @param domain - the custom domain to serve.
 * @param upstreamPort - the orchestrator port to proxy to.
 */
export function renderServerBlock(domain: string, upstreamPort: number): string {
  return [
    `# TODO(P6): nginx server block for ${domain}`,
    'server {',
    '  listen 443 ssl;',
    `  server_name ${domain};`,
    `  location / { proxy_pass http://127.0.0.1:${upstreamPort}; }`,
    '}',
  ].join('\n')
}
