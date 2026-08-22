/**
 * Admin routes: list users and approve/disable accounts. All guarded by
 * `requireAdmin`.
 * @module dsh-server-login/web/routes/admin
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from '../middleware/authn.js'

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: await app.db.listPublicUsers(),
  }))

  app.post('/api/admin/users/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'pending') return reply.code(409).send({ error: 'not_pending' })
    await app.db.setUserRole(id, 'active', request.user?.id)
    await app.db.audit(request.user?.id ?? null, 'approve', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post('/api/admin/users/:id/disable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role === 'admin') return reply.code(409).send({ error: 'cannot_disable_admin' })
    await app.db.setUserRole(id, 'disabled', request.user?.id)
    await app.db.deleteUserSessions(id)
    await app.db.audit(request.user?.id ?? null, 'disable', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post('/api/admin/users/:id/enable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'disabled') return reply.code(409).send({ error: 'not_disabled' })
    await app.db.setUserRole(id, 'active', request.user?.id)
    await app.db.audit(request.user?.id ?? null, 'enable', JSON.stringify({ userId: id }))
    return { ok: true }
  })
}
