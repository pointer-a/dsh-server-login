#!/usr/bin/env node
/**
 * Standalone orchestrator entry (`dsh-server-login` bin).
 *
 * Subcommands:
 *   dsh-server-login bootstrap-admin --username <u> --password <p>
 *   dsh-server-login [server flags]
 * @module dsh-server-login/cli
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { countAdmins, createUser } from './db/repo.js';
import { hashPassword } from './web/auth.js';
import { uidForUser } from './isolation.js';
import { buildServer } from './web/server.js';
const HELP = `dsh-server-login — DSH server login orchestrator

Usage:
  dsh-server-login [options]                      start the server
  dsh-server-login bootstrap-admin [options]      create the first admin

Server options:
  --port <n>        Bind port (0 = ephemeral). Default 3080.
  --host <h>        Bind host. Default 127.0.0.1.
  --db <path>       SQLite database path.
  --data-root <p>   Root for per-user homes + workspaces.
  --dsh-bin <cmd>   Command used to launch a child DSH. Default "dsh".
  --log-level <l>   Pino log level. Default "info".
  --secure-cookies  Set the Secure flag on session cookies (behind HTTPS).
  --session-ttl <s> Session lifetime in seconds. Default 604800 (7 days).
  --isolation-mode <m> Isolation tier: "soft" or "account" (Linux, needs root). Default "soft".
  -h, --help        Show this help.

bootstrap-admin options:
  --username <u>    Admin username (required).
  --password <p>    Admin password (or DSH_SERVER_LOGIN_ADMIN_PASSWORD env).
  --db <path>       Database path.
  --data-root <p>   Root for per-user homes.
`;
function toOverrides(values) {
    const str = (value) => typeof value === 'string' ? value : undefined;
    const dshBin = str(values['dsh-bin']);
    return {
        port: str(values.port),
        host: str(values.host),
        dbPath: str(values.db),
        dataRoot: str(values['data-root']),
        dshCommand: dshBin ? [dshBin] : undefined,
        logLevel: str(values['log-level']),
        secureCookies: values['secure-cookies'] === true ? true : undefined,
        sessionTtlSeconds: str(values['session-ttl']),
        maxUploadBytes: str(values['max-upload']),
        isolationMode: str(values['isolation-mode']),
    };
}
async function bootstrapAdmin(args) {
    const { values } = parseArgs({
        args,
        options: {
            username: { type: 'string' },
            password: { type: 'string' },
            db: { type: 'string' },
            'data-root': { type: 'string' },
        },
    });
    const username = values.username;
    const password = values.password ?? process.env.DSH_SERVER_LOGIN_ADMIN_PASSWORD;
    if (username === undefined || username === '' || password === undefined || password === '') {
        console.error('usage: dsh-server-login bootstrap-admin --username <u> --password <p>');
        process.exit(2);
    }
    const config = resolveConfig({ dbPath: values.db, dataRoot: values['data-root'] });
    const db = openDatabase(config.dbPath);
    if (countAdmins(db) > 0) {
        console.error('an admin already exists; refusing to create a second one');
        db.close();
        process.exit(1);
    }
    const id = randomUUID();
    const homeDir = join(config.dataRoot, 'users', id, 'home');
    mkdirSync(homeDir, { recursive: true });
    chmodSync(homeDir, 0o700);
    const passHash = await hashPassword(password);
    createUser(db, { id, username, passHash, role: 'admin', homeDir });
    db.close();
    console.log(`admin "${username}" created (id: ${id})`);
}
async function runServer(args) {
    const { values } = parseArgs({
        args,
        options: {
            port: { type: 'string' },
            host: { type: 'string' },
            db: { type: 'string' },
            'data-root': { type: 'string' },
            'dsh-bin': { type: 'string' },
            'log-level': { type: 'string' },
            'secure-cookies': { type: 'boolean' },
            'session-ttl': { type: 'string' },
            'max-upload': { type: 'string' },
            'isolation-mode': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        process.stdout.write(HELP);
        return;
    }
    const config = resolveConfig(toOverrides(values));
    const app = await buildServer(config);
    await app.listen({ host: config.host, port: config.port });
    const address = app.server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : config.port;
    app.log.info(`dsh-server-login listening on http://${config.host}:${actualPort}`);
    app.log.info(`data root: ${config.dataRoot}; db: ${config.dbPath}`);
    const shutdown = async (signal) => {
        app.log.info(`received ${signal}, shutting down`);
        await app.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
function uidForUserCmd(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { 'base-uid': { type: 'string' } },
    });
    const userId = positionals[0];
    if (userId === undefined) {
        console.error('usage: dsh-server-login uid-for-user <userId> [--base-uid N]');
        process.exit(2);
    }
    const baseUid = Number(values['base-uid'] ?? process.env.DSH_SERVER_LOGIN_BASE_UID ?? 100000);
    console.log(uidForUser(userId, baseUid));
}
async function main() {
    const [first, ...rest] = process.argv.slice(2);
    if (first === 'bootstrap-admin') {
        await bootstrapAdmin(rest);
        return;
    }
    if (first === 'uid-for-user') {
        uidForUserCmd(rest);
        return;
    }
    await runServer(process.argv.slice(2));
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map