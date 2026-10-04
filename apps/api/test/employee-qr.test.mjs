import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { registerEmployeeRoutes } from '../dist/employee-routes.js';
import { registerEmployeeQrRoutes } from '../dist/employee-qr.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const company = '11111111-1111-4111-8111-111111111111', branch = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333', employee = '44444444-4444-4444-8444-444444444444';
const token = 'e'.repeat(43), qrToken = 'q'.repeat(43);
const headers = { authorization: `Bearer ${token}` };
const attendance = { method: 'POST', url: '/v1/employee/attendance/qr', headers, payload: { qrToken } };
function fixture(options = {}) {
  const state = { active: true, deviceActive: true, scheduled: true, expires: Date.now() + 60000, action: 'CHECK_IN', events: [], claim: null, calls: [], ...options };
  const app = Fastify();
  const query = async (sql, params = []) => {
    state.calls.push({ sql, params }); let rows = [];
    if (sql.startsWith('select e.id as')) {
      if (params[0] === hash(token) && state.active) rows = [{ employeeId: employee, companyId: company }];
    } else if (sql.startsWith('select q.id')) {
      if (params[0] === hash(qrToken) && params[1] === (state.qrCompany || company) && state.deviceActive && !state.keyReset && state.expires > Date.now()) rows = [{ id: 'challenge', company_id: company, branch_id: branch, device_id: device, action: state.action, expires_at: new Date(state.expires), branchName: 'Village Market' }];
    } else if (sql.startsWith('select 1 from attendance_qr_challenges where id')) {
      if (state.expires > Date.now()) rows = [{ exists: true }];
    } else if (sql.startsWith('select ae.id')) { if (state.claim) rows = [state.claim]; }
    else if (sql.startsWith('select action,shift_id')) { if (state.events.length) { const last = state.events.at(-1); rows = [{ action: last.action, shift_id: 'shift', branch_id: state.openBranch || branch }]; } }
    else if (sql.startsWith('select id,starts_at')) { if (state.scheduled) rows = [{ id: 'shift', starts_at: new Date(Date.now() - 600000), ends_at: new Date(Date.now() + 3600000) }]; }
    else if (sql.startsWith('insert into attendance_events')) { const event = { id: `event-${state.events.length}`, action: params[5], status: params[6], occurredAt: params[7] }; state.events.push(event); rows = [event]; }
    else if (sql.startsWith('insert into attendance_qr_claims')) state.claim = state.events.at(-1);
    else if (sql.startsWith('insert into audit_log') && state.failAudit) throw Error('Simulated database failure');
    else if (sql.startsWith('select d.id')) { if (state.deviceActive && params[0] === device && params[1] === company && params[2] === branch && params[3] === hash('device-key')) rows = [{ id: device }]; }
    else if (sql.startsWith('select 1 from attendance_qr_challenges where device_id')) { if (state.recent) rows = [{ exists: true }]; }
    else if (sql.startsWith('insert into attendance_qr_challenges')) { state.issued = params; rows = [{ expiresAt: new Date(Date.now() + 60000) }]; }
    if (sql.includes('select id from employees') && state.revokeDuringLock) state.active = false;
    if (sql.includes('select id from employees') && state.expireDuringLock) state.expires = Date.now() - 1;
    if (sql === 'BEGIN') state.snapshot = { events: [...state.events], claim: state.claim };
    if (sql === 'ROLLBACK' && state.snapshot) { state.events = state.snapshot.events; state.claim = state.snapshot.claim; }
    return { rows, rowCount: rows.length };
  };
  const db = { query, connect: async () => ({ query, release: () => { state.released = true; } }) };
  registerEmployeeRoutes(app, db); registerEmployeeQrRoutes(app, db);
  return { app, state };
}
test('QR issuance requires device credentials and stores only token hash', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  const payload = { companyId: company, branchId: branch, deviceId: device, deviceKey: 'device-key', action: 'CHECK_IN' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/devices/attendance-qr', payload: { ...payload, deviceKey: 'wrong-key' } })).statusCode, 403);
  const response = await app.inject({ method: 'POST', url: '/v1/devices/attendance-qr', payload });
  assert.equal(response.statusCode, 200); const data = response.json(); assert.match(data.qrToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(state.issued[0], hash(data.qrToken)); assert.equal(data.deviceKey, undefined); assert.equal(response.headers['cache-control'], 'no-store');
  state.recent = true; assert.equal((await app.inject({ method: 'POST', url: '/v1/devices/attendance-qr', payload })).statusCode, 429);
});
test('preview gives authoritative action and branch without writing attendance', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  const response = await app.inject({ ...attendance, url: '/v1/employee/attendance/qr/preview' });
  assert.equal(response.statusCode, 200); assert.equal(response.json().branchName, 'Village Market'); assert.equal(response.json().action, 'CHECK_IN'); assert.equal(state.events.length, 0);
});
test('scan records own attendance at server time and retry returns same event', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  const response = await app.inject({ ...attendance, payload: { qrToken, employeeId: 'attacker', action: 'CHECK_OUT', occurredAt: '1990-01-01T00:00:00Z' } });
  assert.equal(response.statusCode, 201); assert.equal(response.json().event.action, 'CHECK_IN'); assert.equal(response.json().event.status, 'LATE');
  const write = state.calls.find(call => call.sql.startsWith('insert into attendance_events'));
  assert.equal(write.params[0], company); assert.equal(write.params[3], employee); assert.ok(Math.abs(Date.now() - Date.parse(write.params[7])) < 5000);
  const repeat = await app.inject(attendance); assert.equal(repeat.statusCode, 200); assert.equal(repeat.json().duplicate, true); assert.equal(repeat.json().event.id, response.json().event.id); assert.equal(state.events.length, 1);
});
test('expired QR, reset device key, disabled device, wrong company and missing authentication fail', async t => {
  for (const options of [{ expires: Date.now() - 1000 }, { keyReset: true }, { deviceActive: false }, { qrCompany: 'other-company' }]) {
    const { app, state } = fixture(options); t.after(() => app.close()); assert.equal((await app.inject(attendance)).statusCode, 410); assert.equal(state.events.length, 0);
  }
  const { app, state } = fixture(); t.after(() => app.close());
  assert.equal((await app.inject({ ...attendance, headers: { authorization: 'Bearer ' + 'x'.repeat(43) } })).statusCode, 401);
  assert.equal((await app.inject({ ...attendance, payload: { qrToken: 'z'.repeat(43) } })).statusCode, 410);
  assert.equal((await app.inject({ ...attendance, payload: { qrToken: 'invalid' } })).statusCode, 400); assert.equal(state.events.length, 0);
});
test('unscheduled worker, repeated check-in, checkout without check-in and wrong checkout branch are rejected', async t => {
  const scenarios = [
    [{ scheduled: false }, 'NO_SCHEDULED_SHIFT'],
    [{ events: [{ action: 'CHECK_IN' }] }, 'ALREADY_CHECKED_IN'],
    [{ action: 'CHECK_OUT' }, 'NO_OPEN_CHECK_IN'],
    [{ action: 'CHECK_OUT', events: [{ action: 'CHECK_IN' }], openBranch: 'other' }, 'CHECK_OUT_AT_ORIGINAL_BRANCH']
  ];
  for (const [options, expected] of scenarios) { const { app } = fixture(options); t.after(() => app.close()); const response = await app.inject(attendance); assert.equal(response.statusCode, 409); assert.equal(response.json().error, expected); }
});
test('checkout closes scheduled open shift', async t => {
  const { app, state } = fixture({ action: 'CHECK_OUT', events: [{ action: 'CHECK_IN' }] }); t.after(() => app.close());
  const response = await app.inject(attendance); assert.equal(response.statusCode, 201); assert.equal(response.json().event.action, 'CHECK_OUT'); assert.equal(state.events.length, 2);
});
test('session revoked while waiting for worker lock cannot write attendance', async t => {
  const { app, state } = fixture({ revokeDuringLock: true }); t.after(() => app.close());
  assert.equal((await app.inject(attendance)).statusCode, 401); assert.equal(state.events.length, 0); assert.equal(state.released, true);
});
test('audit failure rolls back attendance and claim together', async t => {
  const { app, state } = fixture({ failAudit: true }); t.after(() => app.close());
  assert.equal((await app.inject(attendance)).statusCode, 500); assert.equal(state.events.length, 0); assert.equal(state.claim, null); assert.equal(state.released, true);
});

test('QR that expires while waiting for locks cannot record attendance', async t => {
 const { app, state } = fixture({ expireDuringLock: true }); t.after(() => app.close());
 assert.equal((await app.inject(attendance)).statusCode, 410); assert.equal(state.events.length, 0);
});
