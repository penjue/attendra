import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get('/health', async () => ({
  ok: true,
  service: 'attendra-api',
  version: '0.1.0',
  time: new Date().toISOString()
}));

const attendanceSchema = z.object({
  companyId: z.string().min(1),
  branchId: z.string().min(1),
  deviceId: z.string().min(1),
  employeeNumber: z.string().min(1),
  pin: z.string().min(4).max(12),
  action: z.enum(['CHECK_IN', 'CHECK_OUT']),
  occurredAt: z.iso.datetime().optional()
});

app.post('/v1/attendance/events', async (request, reply) => {
  const parsed = attendanceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }

  return reply.code(201).send({
    ok: true,
    event: {
      id: crypto.randomUUID(),
      ...parsed.data,
      pin: undefined,
      receivedAt: new Date().toISOString(),
      status: 'UNSCHEDULED'
    }
  });
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
