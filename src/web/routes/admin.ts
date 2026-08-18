/**
 * Admin routes: list users and approve/disable accounts. All guarded by
 * `requireAdmin`.
 * @module dsh-server-login/web/routes/admin
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from '../middleware/authn.js'
import { audit, deleteUserSessions, findUserById, listPublicUsers, setUserRole } from '../../db/repo.js'

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: listPublicUsers(app.db),
  }))

  app.post('/api/admin/users/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = findUserById(app.db, id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'pending') return reply.code(409).send({ error: 'not_pending' })
    setUserRole(app.db, id, 'active', request.user?.id)
    audit(app.db, request.user?.id ?? null, 'approve', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post('/api/admin/users/:id/disable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = findUserById(app.db, id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role === 'admin') return reply.code(409).send({ error: 'cannot_disable_admin' })
    setUserRole(app.db, id, 'disabled', request.user?.id)
    deleteUserSessions(app.db, id)
    audit(app.db, request.user?.id ?? null, 'disable', JSON.stringify({ userId: id }))
    return { ok: true }
  })
}
