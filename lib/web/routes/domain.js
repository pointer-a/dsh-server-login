/**
 * Custom-domain routes: set/get a user's domain, regenerate its nginx config,
 * and admin verification. Real ACME/DNS ownership verification is deferred;
 * the `verified` flag is set by an admin as a placeholder until then.
 * @module dsh-server-login/web/routes/domain
 */
import { requireAdmin, requireAuth } from '../middleware/authn.js';
import { findDomainById, findDomainByUser, listDomains, setDomainVerified, upsertDomain } from '../../db/repo.js';
import { isValidDomain, renderServerBlock } from '../../nginx/generate.js';
const putSchema = {
    body: {
        type: 'object',
        required: ['domain'],
        additionalProperties: false,
        properties: { domain: { type: 'string', minLength: 1, maxLength: 253 } },
    },
};
export const domainRoutes = async (app) => {
    app.get('/api/domain', { preHandler: requireAuth }, async (request) => {
        const domain = findDomainByUser(app.db, request.user.id);
        if (domain === undefined)
            return { domain: null };
        return { domain: domain.domain, verified: domain.verified === 1, nginx_config: domain.nginxConfig };
    });
    app.put('/api/domain', { preHandler: requireAuth, schema: putSchema }, async (request, reply) => {
        const normalized = request.body.domain.toLowerCase().trim();
        if (!isValidDomain(normalized))
            return reply.code(400).send({ error: 'invalid_domain' });
        const config = renderServerBlock(normalized, request.user.id, app.config.port);
        upsertDomain(app.db, request.user.id, normalized, config);
        return { domain: normalized, verified: false, nginx_config: config };
    });
    app.post('/api/nginx/regen', { preHandler: requireAuth }, async (request, reply) => {
        const domain = findDomainByUser(app.db, request.user.id);
        if (domain === undefined)
            return reply.code(404).send({ error: 'no_domain' });
        const config = renderServerBlock(domain.domain, request.user.id, app.config.port);
        upsertDomain(app.db, request.user.id, domain.domain, config);
        return { domain: domain.domain, nginx_config: config };
    });
    app.get('/api/admin/domains', { preHandler: requireAdmin }, async () => ({
        domains: listDomains(app.db).map((d) => ({
            id: d.id,
            userId: d.userId,
            domain: d.domain,
            verified: d.verified === 1,
        })),
    }));
    app.post('/api/admin/domains/:id/verify', { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        if (findDomainById(app.db, id) === undefined)
            return reply.code(404).send({ error: 'not_found' });
        setDomainVerified(app.db, id, true);
        return { ok: true };
    });
};
//# sourceMappingURL=domain.js.map