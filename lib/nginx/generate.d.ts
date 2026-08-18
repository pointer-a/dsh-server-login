/**
 * nginx `server {}` rendering and domain validation. (P6)
 *
 * `renderServerBlock` produces a per-custom-domain block that rewrites the
 * domain root onto the orchestrator's `/u/<userId>/dsh/` subpath (see
 * docs/domain-config.md §3.1).
 * @module dsh-server-login/nginx/generate
 */
/** Render an nginx server block mapping a custom domain to a user's DSH. */
export declare function renderServerBlock(domain: string, userId: string, upstreamPort: number): string;
/**
 * Validate an ASCII hostname: dot-separated labels of alnum/hyphen, no leading
 * or trailing hyphen, no scheme/path/port.
 */
export declare function isValidDomain(domain: string): boolean;
