import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, pingDatabase } from './db.js';

const app = Fastify({ logger: true });
const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: allowedOrigins.length ? allowedOrigins : true
});

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_COMPANY_ID = process.env.ADMIN_COMPANY_ID ?? '';
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET ?? '';

type AdminToken = { email: string; companyId: string; exp: number };

const safeEqual = (a: string, b: string) => {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
};

const signAdminToken = (payload: AdminToken) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', ADMIN_TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const verifyAdminToken = (token: string): AdminToken | null => {
  if (!ADMIN_TOKEN_SECRET) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', ADMIN_TOKEN_SECRET).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AdminToken;
    if (!payload.email || !payload.companyId || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

const requireAdmin = (request: any, reply: any): AdminToken | null => {
  const header = String(request.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyAdminToken(token);
  if (!payload) {
    reply.code(401).send({ ok: false, error: 'ADMIN_AUTH_REQUIRED' });
    return null;
  }
  return payload;
};

app.get('/health', async (_request, reply) => {
  try {
    const databaseTime = await pingDatabase();
    return {
      ok: true,
      service: 'attendra-api',
      version: '0.2.0',
      database: 'connected',
      databaseTime,
      time: new Date().toISOString()
    };
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({
      ok: false,
      service: 'attendra-api',
      database: 'unavailable',
      time: new Date().toISOString()
    });
  }
});

app.post('/v1/admin/login', async (request, reply) => {
  const parsed = z.object({ email: z.email(), password: z.string().min(8).max(256) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ ok: false, error: 'INVALID_LOGIN_REQUEST' });

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_COMPANY_ID || !ADMIN_TOKEN_SECRET) {
    return reply.code(503).send({ ok: false, error: 'ADMIN_NOT_CONFIGURED' });
  }

  if (!safeEqual(parsed.data.email.trim().toLowerCase(), ADMIN_EMAIL.trim().toLowerCase()) || !safeEqual(parsed.data.password, ADMIN_PASSWORD)) {
    return reply.code(401).send({ ok: false, error: 'INVALID_ADMIN_CREDENTIALS' });
  }

  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const token = signAdminToken({ email: ADMIN_EMAIL, companyId: ADMIN_COMPANY_ID, exp: expiresAt });
  return { ok: true, token, expiresAt, companyId: ADMIN_COMPANY_ID, email: ADMIN_EMAIL };
});

const attendanceSchema = z.object({
  companyId: z.uuid(),
  branchId: z.uuid(),
  deviceId: z.uuid(),
  employeeNumber: z.string().trim().min(1).max(64),
  pin: z.string().regex(/^\d{4,12}$/),
  action: z.enum(['CHECK_IN', 'CHECK_OUT']),
  occurredAt: z.iso.datetime().optional()
});

app.post('/v1/attendance/events', async (request, reply) => {
  const parsed = attendanceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }

  const input = parsed.data;
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const deviceResult = await client.query(
      `select id from devices
       where id = $1 and company_id = $2 and branch_id = $3 and active = true
       for update`,
      [input.deviceId, input.companyId, input.branchId]
    );

    if (!deviceResult.rowCount) {
      await client.query('ROLLBACK');
      return reply.code(403).send({ ok: false, error: 'DEVICE_NOT_AUTHORISED' });
    }

    const employeeResult = await client.query(
      `select id, first_name, last_name
       from employees
       where company_id = $1
         and employee_number = $2
         and active = true
         and pin_hash = crypt($3, pin_hash)
       limit 1`,
      [input.companyId, input.employeeNumber, input.pin]
    );

    if (!employeeResult.rowCount) {
      await client.query('ROLLBACK');
      return reply.code(401).send({ ok: false, error: 'INVALID_EMPLOYEE_OR_PIN' });
    }

    const employee = employeeResult.rows[0];
    const shiftResult = await client.query(
      `select id, starts_at, ends_at
       from shifts
       where company_id = $1
         and branch_id = $2
         and employee_id = $3
         and $4::timestamptz between starts_at - interval '4 hours' and ends_at + interval '4 hours'
       order by abs(extract(epoch from (starts_at - $4::timestamptz)))
       limit 1`,
      [input.companyId, input.branchId, employee.id, occurredAt.toISOString()]
    );

    const shift = shiftResult.rows[0] ?? null;
    let status: 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED' = 'UNSCHEDULED';

    if (shift && input.action === 'CHECK_IN') {
      const start = new Date(shift.starts_at).getTime();
      const eventTime = occurredAt.getTime();
      const graceMs = 5 * 60 * 1000;
      status = eventTime > start + graceMs ? 'LATE' : eventTime < start - graceMs ? 'EARLY' : 'ON_TIME';
    } else if (shift && input.action === 'CHECK_OUT') {
      status = 'ON_TIME';
    }

    const insertResult = await client.query(
      `insert into attendance_events
        (company_id, branch_id, device_id, employee_id, shift_id, action, status, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, action, status, occurred_at, received_at`,
      [input.companyId, input.branchId, input.deviceId, employee.id, shift?.id ?? null, input.action, status, occurredAt.toISOString()]
    );

    await client.query('update devices set last_seen_at = now() where id = $1', [input.deviceId]);
    await client.query(
      `insert into audit_log (company_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       values ($1, 'DEVICE', $2, $3, 'ATTENDANCE_EVENT', $4, jsonb_build_object('employeeId', $5::uuid, 'branchId', $6::uuid))`,
      [input.companyId, input.deviceId, input.action, insertResult.rows[0].id, employee.id, input.branchId]
    );

    await client.query('COMMIT');

    return reply.code(201).send({
      ok: true,
      employee: {
        id: employee.id,
        employeeNumber: input.employeeNumber,
        name: `${employee.first_name} ${employee.last_name}`
      },
      event: insertResult.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: 'ATTENDANCE_WRITE_FAILED' });
  } finally {
    client.release();
  }
});

app.get('/v1/companies/:companyId/attendance/recent', async (request, reply) => {
  const admin = requireAdmin(request, reply);
  if (!admin) return;
  const params = z.object({ companyId: z.uuid() }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ ok: false, error: 'INVALID_COMPANY_ID' });
  if (params.data.companyId !== admin.companyId) return reply.code(403).send({ ok: false, error: 'COMPANY_ACCESS_DENIED' });

  const result = await db.query(
    `select ae.id,
            ae.action,
            ae.status,
            ae.occurred_at as "occurredAt",
            e.employee_number as "employeeNumber",
            concat(e.first_name, ' ', e.last_name) as "employeeName",
            b.name as "branchName"
     from attendance_events ae
     join employees e on e.id = ae.employee_id
     join branches b on b.id = ae.branch_id
     where ae.company_id = $1
     order by ae.occurred_at desc
     limit 50`,
    [params.data.companyId]
  );

  return { ok: true, events: result.rows };
});

app.get('/v1/companies/:companyId/attendance/summary', async (request, reply) => {
  const admin = requireAdmin(request, reply);
  if (!admin) return;
  const params = z.object({ companyId: z.uuid() }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ ok: false, error: 'INVALID_COMPANY_ID' });
  if (params.data.companyId !== admin.companyId) return reply.code(403).send({ ok: false, error: 'COMPANY_ACCESS_DENIED' });

  const result = await db.query(
    `with latest as (
       select distinct on (employee_id) employee_id, action
       from attendance_events
       where company_id = $1
       order by employee_id, occurred_at desc
     )
     select
       (select count(*)::int from latest where action = 'CHECK_IN') as "checkedInNow",
       (select count(*)::int from attendance_events where company_id = $1 and status = 'LATE' and occurred_at::date = current_date) as "lateToday",
       (select count(*)::int from devices where company_id = $1 and active = true and (last_seen_at is null or last_seen_at < now() - interval '30 minutes')) as "offlineDevices"`,
    [params.data.companyId]
  );

  return { ok: true, summary: { ...result.rows[0], absent: 0 } };
});

app.get('/v1/admin/employees', async (request, reply) => {
  const admin = requireAdmin(request, reply);
  if (!admin) return;
  const result = await db.query(
    `select id,
            employee_number as "employeeNumber",
            first_name as "firstName",
            last_name as "lastName",
            hourly_worker as "hourlyWorker",
            active,
            created_at as "createdAt"
     from employees
     where company_id = $1
     order by active desc, first_name, last_name`,
    [admin.companyId]
  );
  return { ok: true, employees: result.rows };
});

app.post('/v1/admin/employees', async (request, reply) => {
  const admin = requireAdmin(request, reply);
  if (!admin) return;
  const parsed = z.object({
    employeeNumber: z.string().trim().min(1).max(64),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    pin: z.string().regex(/^\d{4,12}$/),
    hourlyWorker: z.boolean().default(false)
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ ok: false, error: 'INVALID_EMPLOYEE', details: parsed.error.flatten() });

  try {
    const result = await db.query(
      `insert into employees (company_id, employee_number, first_name, last_name, pin_hash, hourly_worker)
       values ($1,$2,$3,$4,crypt($5, gen_salt('bf')),$6)
       returning id, employee_number as "employeeNumber", first_name as "firstName", last_name as "lastName", hourly_worker as "hourlyWorker", active, created_at as "createdAt"`,
      [admin.companyId, parsed.data.employeeNumber, parsed.data.firstName, parsed.data.lastName, parsed.data.pin, parsed.data.hourlyWorker]
    );
    return reply.code(201).send({ ok: true, employee: result.rows[0] });
  } catch (error: any) {
    if (error?.code === '23505') return reply.code(409).send({ ok: false, error: 'EMPLOYEE_NUMBER_EXISTS' });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: 'EMPLOYEE_CREATE_FAILED' });
  }
});

app.patch('/v1/admin/employees/:employeeId', async (request, reply) => {
  const admin = requireAdmin(request, reply);
  if (!admin) return;
  const params = z.object({ employeeId: z.uuid() }).safeParse(request.params);
  const body = z.object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    pin: z.string().regex(/^\d{4,12}$/).optional(),
    hourlyWorker: z.boolean().optional(),
    active: z.boolean().optional()
  }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ ok: false, error: 'INVALID_EMPLOYEE_UPDATE' });

  const result = await db.query(
    `update employees
     set first_name = coalesce($3, first_name),
         last_name = coalesce($4, last_name),
         pin_hash = case when $5::text is null then pin_hash else crypt($5, gen_salt('bf')) end,
         hourly_worker = coalesce($6, hourly_worker),
         active = coalesce($7, active)
     where id = $1 and company_id = $2
     returning id, employee_number as "employeeNumber", first_name as "firstName", last_name as "lastName", hourly_worker as "hourlyWorker", active, created_at as "createdAt"`,
    [params.data.employeeId, admin.companyId, body.data.firstName ?? null, body.data.lastName ?? null, body.data.pin ?? null, body.data.hourlyWorker ?? null, body.data.active ?? null]
  );
  if (!result.rowCount) return reply.code(404).send({ ok: false, error: 'EMPLOYEE_NOT_FOUND' });
  return { ok: true, employee: result.rows[0] };
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
