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
export declare function renderServerBlock(domain: string, upstreamPort: number): string;
