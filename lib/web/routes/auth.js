/**
 * Auth routes: self-registration (→ pending), login, logout, and the current
 * identity. Registration always yields a `pending` user; an admin approves it.
 * @module dsh-server-login/web/routes/auth
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../middleware/authn.js';
import { audit, createSession, createUser, deleteSession, findUserByUsername, toPublicUser, } from '../../db/repo.js';
import { clearSessionCookie, hashPassword, hashSessionToken, newSessionToken, parseCookie, sessionCookie, verifyPassword, } from '../auth.js';
const registerSchema = {
    body: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
            username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_-]+$' },
            password: { type: 'string', minLength: 8, maxLength: 128 },
        },
    },
};
const loginSchema = {
    body: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
            username: { type: 'string', maxLength: 64 },
            password: { type: 'string', maxLength: 128 },
        },
    },
};
export const authRoutes = async (app) => {
    app.post('/api/auth/register', { schema: registerSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { username, password } = request.body;
        const db = app.db;
        if (findUserByUsername(db, username) !== undefined) {
            return reply.code(409).send({ error: 'username_taken' });
        }
        const id = randomUUID();
        const homeDir = join(app.config.dataRoot, 'users', id, 'home');
        mkdirSync(homeDir, { recursive: true });
        chmodSync(homeDir, 0o700);
        const passHash = await hashPassword(password);
        createUser(db, { id, username, passHash, role: 'pending', homeDir });
        audit(db, id, 'register', JSON.stringify({ username }));
        return reply.code(201).send({ user: { id, username, role: 'pending' } });
    });
    app.post('/api/auth/login', { schema: loginSchema, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { username, password } = request.body;
        const db = app.db;
        const user = findUserByUsername(db, username);
        if (user === undefined || !(await verifyPassword(password, user.pass_hash))) {
            return reply.code(401).send({ error: 'invalid_credentials' });
        }
        if (user.role === 'pending')
            return reply.code(403).send({ error: 'pending_review' });
        if (user.role === 'disabled')
            return reply.code(403).send({ error: 'disabled' });
        const token = newSessionToken();
        createSession(db, {
            tokenHash: hashSessionToken(token),
            userId: user.id,
            expiresAt: Date.now() + app.config.sessionTtlSeconds * 1000,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
        });
        audit(db, user.id, 'login', null);
        reply.header('set-cookie', sessionCookie(token, app.config.sessionTtlSeconds, app.config.secureCookies, app.config.cookieDomain));
        return { user: toPublicUser(user) };
    });
    app.post('/api/auth/logout', async (request, reply) => {
        const token = parseCookie(request.headers.cookie, 'sid');
        if (token !== undefined)
            deleteSession(app.db, hashSessionToken(token));
        reply.header('set-cookie', clearSessionCookie(app.config.secureCookies, app.config.cookieDomain));
        return { ok: true };
    });
    app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }));
};
//# sourceMappingURL=auth.js.map