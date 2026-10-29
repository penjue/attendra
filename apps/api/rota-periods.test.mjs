import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRotaPeriod,rotaShiftDate} from './dist/rota-periods.js';

test('weekly periods advance by seven days across years',()=>{
 assert.equal(nextRotaPeriod('2026-12-28','WEEKLY'),'2027-01-04');
 assert.equal(rotaShiftDate('2026-12-28','WEEKLY',6),'2027-01-03');
 assert.equal(rotaShiftDate('2026-12-28','WEEKLY',7),null);
});
test('monthly periods advance from the first without drift',()=>{
 assert.equal(nextRotaPeriod('2027-01-01','MONTHLY'),'2027-02-01');
 assert.equal(nextRotaPeriod('2027-02-01','MONTHLY'),'2027-03-01');
 assert.equal(nextRotaPeriod('2028-02-01','MONTHLY'),'2028-03-01');
});
test('monthly offsets never spill into next month',()=>{
 assert.equal(rotaShiftDate('2027-02-01','MONTHLY',27),'2027-02-28');
 assert.equal(rotaShiftDate('2027-02-01','MONTHLY',28),null);
 assert.equal(rotaShiftDate('2028-02-01','MONTHLY',28),'2028-02-29');
 assert.equal(rotaShiftDate('2028-02-01','MONTHLY',29),null);
 assert.equal(rotaShiftDate('2026-04-01','MONTHLY',29),'2026-04-30');
 assert.equal(rotaShiftDate('2026-04-01','MONTHLY',30),null);
 assert.equal(rotaShiftDate('2026-05-01','MONTHLY',30),'2026-05-31');
});
test('invalid dates and offsets are rejected',()=>{
 assert.throws(()=>nextRotaPeriod('2026-02-30','WEEKLY'),/INVALID_DATE/);
 assert.throws(()=>nextRotaPeriod('2026-01-15','MONTHLY'),/MONTHLY_PERIOD/);
 assert.equal(rotaShiftDate('2026-01-01','MONTHLY',-1),null);
 assert.equal(rotaShiftDate('2026-01-01','MONTHLY',1.5),null);
});
