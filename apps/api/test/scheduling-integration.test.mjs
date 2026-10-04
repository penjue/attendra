import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
const url=process.env.SCHEDULING_TEST_DATABASE_URL;
test('PostgreSQL scheduling: migrations, isolation, drafts, exceptions, cover and concurrency',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;process.env.ADMIN_TOKEN_SECRET='scheduling-integration-secret';
 const {registerSchedulingRoutes}=await import('../dist/scheduling.js');
 const {signAdminToken}=await import('../dist/admin-auth.js');
 const {db:authPool}=await import('../dist/db.js');
 const pool=new pg.Pool({connectionString:url}),app=Fastify();registerSchedulingRoutes(app,pool);
 const company=randomUUID(),other=randomUUID(),branch=randomUUID(),otherBranch=randomUUID(),employee=randomUUID(),cover=randomUUID(),overlap=randomUUID(),wrongRole=randomUUID();
 const headers={authorization:`Bearer ${signAdminToken({email:'manager@example.test',companyId:company,role:'MANAGER',exp:Date.now()+600000})}`};
 const request=(method,path,payload)=>app.inject({method,url:'/v1/admin/scheduling/'+path,headers,payload});
 const success=async(method,path,payload)=>{const r=await request(method,path,payload);assert.equal(r.statusCode,200,r.body);return r.json()};
 const day='2099-06-01';let shiftId,patternId,absenceId;
 try{
  const schema=await readFile(new URL('../../../database/schema.sql',import.meta.url),'utf8');await pool.query(schema);await pool.query(schema);
  await pool.query("insert into companies(id,name,country_code,timezone,currency) values($1,'Scheduling test','GB','Europe/London','GBP'),($2,'Other company','KE','Africa/Nairobi','KES')",[company,other]);
  await pool.query("insert into branches(id,company_id,name,timezone) values($1,$2,'Main branch','Europe/London'),($3,$4,'Other branch','Africa/Nairobi')",[branch,company,otherBranch,other]);
  for(const [i,id] of [employee,cover,overlap,wrongRole].entries())await pool.query("insert into employees(id,company_id,employee_number,first_name,last_name,pin_hash) values($1,$2,$3,$4,'Test',crypt('1234',gen_salt('bf')))",[id,company,String(i),['Eve','Cover','Busy','Cashier'][i]]);
  await t.test('authentication and company isolation',async()=>{
   assert.equal((await app.inject({url:'/v1/admin/scheduling/meta'})).statusCode,401);
   const d=await success('GET','meta');assert.equal(d.employees.length,4);assert.equal(d.branches.length,1);
   const r=await request('POST','patterns',{name:'Other branch',employeeIds:[employee],branchId:otherBranch,weekdays:[1],startTime:'08:00',endTime:'17:00',breakMinutes:60});assert.equal(r.statusCode,404);assert.equal(r.json().error,'BRANCH_NOT_FOUND');
   assert.equal((await pool.query('select id from shift_patterns where company_id=$1',[company])).rowCount,0);
  });
  await t.test('branch-local pattern generation is idempotent and remains a draft',async()=>{
   await success('PUT',`profiles/${employee}`,{jobRole:'Barista',maxWeeklyHours:40,allowedBranchIds:[branch]});
   await success('POST','patterns',{name:'Morning',employeeIds:[employee],branchId:branch,weekdays:[1,2,3,4,5,6,7],startTime:'08:00',endTime:'17:00',breakMinutes:60});
   patternId=(await success('GET','patterns')).patterns[0].id;
   assert.equal((await success('POST','generate',{from:day,to:day,patternIds:[patternId]})).created,1);
   assert.equal((await success('POST','generate',{from:day,to:day,patternIds:[patternId]})).existing,1);
   const d=await success('GET',`calendar?from=${day}&to=${day}`);assert.equal(d.shifts.length,1);assert.equal(d.shifts[0].published,false);assert.equal(new Date(d.shifts[0].startsAt).toISOString(),day+'T07:00:00.000Z');shiftId=d.shifts[0].id;
   const token='s'.repeat(43);const pin=(await pool.query('select pin_hash from employees where id=$1',[employee])).rows[0].pin_hash;
   await pool.query("insert into employee_sessions(token_hash,company_id,employee_id,credential_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 day')",[createHash('sha256').update(token).digest('hex'),company,employee,createHash('sha256').update(pin).digest('hex')]);
   const getEmployee=()=>app.inject({url:`/v1/employee/schedule?from=${day}&to=${day}&employeeId=${cover}&companyId=${other}`,headers:{authorization:`Bearer ${token}`}});
   assert.equal((await getEmployee()).json().shifts.length,0);
   assert.equal((await success('POST','publish',{shiftIds:[shiftId]})).published,1);
   const own=(await getEmployee()).json();assert.equal(own.shifts.length,1);assert.equal(own.notices.length,1);
  });
  await t.test('availability blocks published attendance and repeat patterns stay intact',async()=>{
   absenceId=(await success('POST','unavailability',{employeeId:employee,fromDate:day,toDate:day,category:'INJURY'})).id;
   const d=await success('GET',`calendar?from=${day}&to=${day}`);assert.equal(d.shifts[0].needsCover,true);
   const a=(await success('GET',`unavailability?from=${day}&to=${day}`)).unavailability[0];assert.equal(new Date(a.startsAt).toISOString(),'2099-05-31T23:00:00.000Z');assert.equal(new Date(a.endsAt).toISOString(),'2099-06-01T23:00:00.000Z');
   await assert.rejects(pool.query("insert into attendance_events(company_id,branch_id,employee_id,shift_id,action,status,occurred_at,source) values($1,$2,$3,$4,'CHECK_IN','ON_TIME',$5,'EMPLOYEE_QR')",[company,branch,employee,shiftId,day+'T07:00:00Z']),e=>e.message==='EMPLOYEE_UNAVAILABLE');
   assert.equal((await success('GET','patterns')).patterns.length,1);
  });
  await t.test('cover excludes overlapping shifts and mismatched roles and is revalidated at assignment',async()=>{
   for(const id of [cover,overlap])await success('PUT',`profiles/${id}`,{jobRole:'Barista',maxWeeklyHours:40,allowedBranchIds:[branch]});
   await success('PUT',`profiles/${wrongRole}`,{jobRole:'Cashier',maxWeeklyHours:40,allowedBranchIds:[branch]});
   await success('POST','drafts',{employeeIds:[overlap],branchId:branch,date:day,startTime:'08:00',endTime:'17:00',breakMinutes:60});
   const options=await success('GET',`shifts/${shiftId}/cover`);assert.deepEqual(options.candidates.map(c=>c.employeeId),[cover]);
   const busyAbsence=(await success('POST','unavailability',{employeeId:cover,fromDate:day,toDate:day,category:'LEAVE'})).id;
   const r=await request('POST',`shifts/${shiftId}/cover`,{employeeId:cover});assert.equal(r.statusCode,409);assert.equal(r.json().error,'COVER_NO_LONGER_AVAILABLE');
   await success('DELETE',`unavailability/${busyAbsence}`);await success('POST',`shifts/${shiftId}/cover`,{employeeId:cover});
   const row=(await pool.query('select employee_id,pattern_id from shifts where id=$1',[shiftId])).rows[0];assert.equal(row.employee_id,cover);assert.equal(row.pattern_id,patternId);
   assert.equal((await success('POST','generate',{from:day,to:day,patternIds:[patternId]})).existing,1);
  });
  await t.test('unavailable pattern dates produce cover drafts and cannot publish until resolved',async()=>{
   const next='2099-06-02';await success('POST','unavailability',{employeeId:employee,fromDate:next,toDate:next,category:'DAY_OFF'});
   const gen=await success('POST','generate',{from:next,to:next,patternIds:[patternId]});assert.equal(gen.created,1);assert.equal(gen.needsCover.length,1);
   const calendar=await success('GET',`calendar?from=${next}&to=${next}`);const draft=calendar.shifts[0];assert.equal(draft.needsCover,true);
   const r=await request('POST','publish',{shiftIds:[draft.id]});assert.equal(r.statusCode,409);assert.equal(r.json().error,'EMPLOYEE_UNAVAILABLE');assert.equal((await pool.query('select published from shifts where id=$1',[draft.id])).rows[0].published,false);
  });
  await t.test('weekly hours, overlap, malformed times and concurrent drafts are guarded',async()=>{
   await success('PUT',`profiles/${wrongRole}`,{jobRole:'Cashier',maxWeeklyHours:8,allowedBranchIds:[branch]});
   const data={employeeIds:[wrongRole],branchId:branch,date:day,startTime:'08:00',endTime:'17:00',breakMinutes:60};
   const both=await Promise.all([request('POST','drafts',data),request('POST','drafts',data)]);assert.deepEqual(both.map(r=>r.statusCode).sort(),[200,409]);
   const r=await request('POST','drafts',{...data,date:'2099-06-02'});assert.equal(r.statusCode,409);assert.equal(r.json().error,'WEEKLY_HOURS_EXCEEDED');
   assert.equal((await request('POST','drafts',{...data,startTime:'08:00',endTime:'08:00'})).statusCode,400);
   await assert.rejects(pool.query("insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at) values($1,$2,$3,'2099-06-01T08:00Z','2099-06-01T09:00Z')",[company,wrongRole,branch]),e=>e.message==='SHIFT_OVERLAP');
  });
  await t.test('stopping patterns and deleting exceptions preserves generated shifts',async()=>{
   await success('DELETE',`patterns/${patternId}`);await success('DELETE',`unavailability/${absenceId}`);
   assert.equal((await success('GET','patterns')).patterns.length,0);assert.equal((await pool.query('select id from shifts where id=$1',[shiftId])).rowCount,1);
  });
 }finally{
  await app.close();
  await pool.query('delete from attendance_events where company_id=ANY($1::uuid[])',[[company,other]]);
  await pool.query('delete from shifts where company_id=ANY($1::uuid[])',[[company,other]]);
  await pool.query('delete from companies where id=ANY($1::uuid[])',[[company,other]]);
  await pool.end();await authPool.end();
 }
});
