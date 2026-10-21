import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireAdmin } from './admin-auth.js';

const taskInput = z.object({
  employeeId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(''),
  dueAt: z.iso.datetime({ offset: true }).optional()
});
const statusInput = z.object({ status: z.enum(['UNDER_REVIEW', 'RESOLVED']) });
const paramsInput = z.object({ id: z.uuid() });

export function registerWorkManagementRoutes(app: FastifyInstance, db: Pick<Pool, 'query'>) {
  app.get('/v1/admin/tasks', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const result = await db.query(
      'SELECT id, employee_id AS "employeeId", title, description, due_at AS "dueAt", status, created_at AS "createdAt" FROM employee_tasks WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100',
      [admin.companyId]
    );
    return { ok: true, tasks: result.rows };
  });

  app.post('/v1/admin/tasks', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = taskInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'INVALID_TASK' });
    const task = parsed.data;
    const result = await db.query(
      `INSERT INTO employee_tasks(company_id, employee_id, title, description, due_at)
       SELECT $1, e.id, $3, $4, $5 FROM employees e
       WHERE e.company_id=$1 AND e.id=$2 AND e.active=true
       RETURNING id, status, created_at AS "createdAt"`,
      [admin.companyId, task.employeeId, task.title, task.description, task.dueAt ?? null]
    );
    if (!result.rowCount) return reply.code(404).send({ ok: false, error: 'EMPLOYEE_NOT_FOUND' });
    return reply.code(201).send({ ok: true, task: result.rows[0] });
  });

  app.get('/v1/admin/incidents', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const result = await db.query(
      'SELECT id, employee_id AS "employeeId", category, description, occurred_at AS "occurredAt", status, created_at AS "createdAt" FROM employee_incidents WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100',
      [admin.companyId]
    );
    return { ok: true, incidents: result.rows };
  });

  app.patch('/v1/admin/incidents/:id/status', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const params = paramsInput.safeParse(request.params);
    const body = statusInput.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ ok: false, error: 'INVALID_INCIDENT_UPDATE' });
    const result = await db.query(
      `UPDATE employee_incidents SET status=$3, reviewed_at=now(), reviewed_by=$4
       WHERE company_id=$1 AND id=$2 AND status<>'RESOLVED'
       RETURNING id, status, reviewed_at AS "reviewedAt"`,
      [admin.companyId, params.data.id, body.data.status, admin.email]
    );
    if (!result.rowCount) return reply.code(404).send({ ok: false, error: 'INCIDENT_NOT_FOUND_OR_RESOLVED' });
    return { ok: true, incident: result.rows[0] };
  });
}
