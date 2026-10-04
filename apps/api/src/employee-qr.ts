import { attendancePolicyError } from './attendance-policy.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticateEmployee } from './employee-routes.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const qrBody = z.object({ qrToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const deviceBody = z.object({ companyId: z.uuid(), branchId: z.uuid(), deviceId: z.uuid(), deviceKey: z.string().min(1).max(256), action: z.enum(['CHECK_IN', 'CHECK_OUT']) });
const challengeSql = `select q.id,q.company_id,q.branch_id,q.device_id,q.action,q.expires_at,b.name as "branchName"
 from attendance_qr_challenges q join devices d on d.id=q.device_id and d.company_id=q.company_id and d.branch_id=q.branch_id
 join branches b on b.id=q.branch_id and b.company_id=q.company_id
 where q.token_hash=$1 and q.company_id=$2 and q.expires_at>clock_timestamp()
 and d.active=true and b.active=true and d.device_key_hash=q.device_key_hash`;

export function registerEmployeeQrRoutes(app: FastifyInstance, db: Pick<Pool, 'query' | 'connect'>) {
  app.post('/v1/devices/attendance-qr', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = deviceBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'INVALID_QR_REQUEST' });
    const input = parsed.data;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const device = await client.query(`select d.id from devices d join branches b on b.id=d.branch_id and b.company_id=d.company_id
       where d.id=$1 and d.company_id=$2 and d.branch_id=$3 and d.device_key_hash=$4 and d.active=true and b.active=true for update of d`,
      [input.deviceId, input.companyId, input.branchId, hash(input.deviceKey)]);
      if (!device.rowCount) { await client.query('ROLLBACK'); return reply.code(403).send({ ok: false, error: 'DEVICE_NOT_AUTHORISED' }); }
      // Rate-limit creation under the device lock, including concurrent requests.
      const recent = await client.query(`select 1 from attendance_qr_challenges where device_id=$1 and action=$2 and created_at>clock_timestamp()-interval '5 seconds' limit 1`, [input.deviceId, input.action]);
      if (recent.rowCount) { await client.query('ROLLBACK'); return reply.code(429).header('Retry-After', '5').send({ ok: false, error: 'QR_REFRESH_TOO_FAST' }); }
      await client.query(`delete from attendance_qr_challenges where device_id=$1 and expires_at<clock_timestamp()-interval '1 day'`, [input.deviceId]);
      const qrToken = randomBytes(32).toString('base64url');
      const result = await client.query(`insert into attendance_qr_challenges(token_hash,company_id,branch_id,device_id,device_key_hash,action,expires_at)
       values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '60 seconds') returning expires_at as "expiresAt"`,
      [hash(qrToken), input.companyId, input.branchId, input.deviceId, hash(input.deviceKey), input.action]);
      await client.query('update devices set last_seen_at=now() where id=$1', [input.deviceId]);
      await client.query('COMMIT');
      return { ok: true, qrToken, action: input.action, expiresAt: result.rows[0].expiresAt };
    } catch (error) {
      await client.query('ROLLBACK'); app.log.error(error);
      return reply.code(500).send({ ok: false, error: 'QR_CREATE_FAILED' });
    } finally { client.release(); }
  });

  app.post('/v1/employee/attendance/qr/preview', async (request, reply) => {
    const employee = await authenticateEmployee(db, request.headers.authorization);
    if (!employee) return reply.code(401).send({ ok: false, error: 'EMPLOYEE_AUTH_REQUIRED' });
    const parsed = qrBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'INVALID_QR_CODE' });
    const result = await db.query(challengeSql, [hash(parsed.data.qrToken), employee.companyId]);
    if (!result.rowCount) return reply.code(410).send({ ok: false, error: 'QR_EXPIRED_OR_UNAVAILABLE' });
    const row = result.rows[0];
    return { ok: true, action: row.action, branchName: row.branchName, expiresAt: row.expires_at };
  });

  app.post('/v1/employee/attendance/qr', async (request, reply) => {
    const employee = await authenticateEmployee(db, request.headers.authorization);
    if (!employee) return reply.code(401).send({ ok: false, error: 'EMPLOYEE_AUTH_REQUIRED' });
    const parsed = qrBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'INVALID_QR_CODE' });
    const client: PoolClient = await db.connect();
    const reject = async (status: number, error: string) => { await client.query('ROLLBACK'); return reply.code(status).send({ ok: false, error }); };
    try {
      await client.query('BEGIN');
      // Device then worker locks serialize scans with tablet writes and other QR scans.
      const challenge = await client.query(challengeSql + ' for update of d', [hash(parsed.data.qrToken), employee.companyId]);
      if (!challenge.rowCount) return await reject(410, 'QR_EXPIRED_OR_UNAVAILABLE');
      const qr = challenge.rows[0];
      await client.query('select id from employees where id=$1 and company_id=$2 for update', [employee.employeeId, employee.companyId]);
      if (!await authenticateEmployee(client, request.headers.authorization)) return await reject(401, 'EMPLOYEE_AUTH_REQUIRED');
      // Re-check expiry after acquiring locks: a queued scan must not use an expired QR.
      const fresh = await client.query('select 1 from attendance_qr_challenges where id=$1 and expires_at>clock_timestamp()', [qr.id]);
      if (!fresh.rowCount) return await reject(410, 'QR_EXPIRED_OR_UNAVAILABLE');
      const duplicate = await client.query(`select ae.id,ae.action,ae.status,ae.occurred_at as "occurredAt" from attendance_qr_claims qc
       join attendance_events ae on ae.id=qc.event_id where qc.challenge_id=$1 and qc.employee_id=$2`, [qr.id, employee.employeeId]);
      if (duplicate.rowCount) { await client.query('COMMIT'); return { ok: true, duplicate: true, event: duplicate.rows[0] }; }
      const latest = await client.query(`select action,shift_id,branch_id from attendance_events where company_id=$1 and employee_id=$2 order by occurred_at desc,received_at desc,id desc limit 1`, [employee.companyId, employee.employeeId]);
      const open = latest.rows[0]?.action === 'CHECK_IN' ? latest.rows[0] : null;
      if (qr.action === 'CHECK_IN' && open) return await reject(409, 'ALREADY_CHECKED_IN');
      if (qr.action === 'CHECK_OUT' && !open) return await reject(409, 'NO_OPEN_CHECK_IN');
      if (open && open.branch_id !== qr.branch_id) return await reject(409, 'CHECK_OUT_AT_ORIGINAL_BRANCH');
      const now = new Date();
      const shift = qr.action === 'CHECK_OUT'
        ? await client.query(`select id,starts_at,ends_at from shifts where id=$1 and company_id=$2 and employee_id=$3 and branch_id=$4 for update`, [open.shift_id, employee.companyId, employee.employeeId, qr.branch_id])
        : await client.query(`select id,starts_at,ends_at from shifts where published=true and company_id=$1 and employee_id=$2 and branch_id=$3 and $4::timestamptz between starts_at-interval '4 hours' and ends_at+interval '4 hours' order by abs(extract(epoch from(starts_at-$4::timestamptz))) limit 1 for update`, [employee.companyId, employee.employeeId, qr.branch_id, now.toISOString()]);
      if (!shift.rowCount) return await reject(409, 'NO_SCHEDULED_SHIFT');
      const scheduled = shift.rows[0];
      if (qr.action === 'CHECK_IN') {
        const completed = await client.query(`select 1 from attendance_events where company_id=$1 and employee_id=$2 and shift_id=$3 and action='CHECK_OUT' limit 1`, [employee.companyId, employee.employeeId, scheduled.id]);
        if (completed.rowCount) return await reject(409, 'SHIFT_ALREADY_COMPLETED');
      }
      const delta = now.getTime() - new Date(scheduled.starts_at).getTime();
      const status = qr.action === 'CHECK_IN' ? delta > 300000 ? 'LATE' : delta < -300000 ? 'EARLY' : 'ON_TIME' : 'ON_TIME';
      const event = await client.query(`insert into attendance_events(company_id,branch_id,device_id,employee_id,shift_id,action,status,occurred_at,source)
       values($1,$2,$3,$4,$5,$6,$7,$8,'EMPLOYEE_QR') returning id,action,status,occurred_at as "occurredAt"`,
      [employee.companyId, qr.branch_id, qr.device_id, employee.employeeId, scheduled.id, qr.action, status, now.toISOString()]);
      await client.query('insert into attendance_qr_claims(challenge_id,employee_id,event_id) values($1,$2,$3)', [qr.id, employee.employeeId, event.rows[0].id]);
      await client.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
       values($1,'EMPLOYEE',$2,$3,'ATTENDANCE_EVENT',$4,jsonb_build_object('deviceId',$5::uuid,'branchId',$6::uuid,'source','EMPLOYEE_QR'))`,
      [employee.companyId, employee.employeeId, qr.action, event.rows[0].id, qr.device_id, qr.branch_id]);
      await client.query('COMMIT');
      return reply.code(201).send({ ok: true, event: event.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      if (attendancePolicyError(error)) return reply.code(409).send({ ok: false, error: attendancePolicyError(error) });
      app.log.error(error);
      return reply.code(500).send({ ok: false, error: 'ATTENDANCE_WRITE_FAILED' });
    } finally { client.release(); }
  });
}
