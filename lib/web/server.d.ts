/**
 * Fastify bootstrap: assembles the HTTP server, registers plugins and routes,
 * and owns the DB lifecycle via the close hook.
 * @module dsh-server-login/web/server
 */
import { type FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { type Database } from '../db/connection.js';
import type { PublicUser } from '../db/repo.js';
declare module 'fastify' {
    interface FastifyInstance {
        db: Database;
        config: ServerConfig;
    }
    interface FastifyRequest {
        user: PublicUser | null;
    }
}
/**
 * Build a fully-wired Fastify instance. Does not call `listen`; the caller owns
 * bind + shutdown.
 * @param config - resolved runtime configuration.
 */
export declare function buildServer(config: ServerConfig): Promise<FastifyInstance>;
