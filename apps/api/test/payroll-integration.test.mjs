import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
const url=process.env.SCHEDULING_TEST_DATABASE_URL;
test('payroll: real PostgreSQL approval, adjustments, isolation and immutable PDF snapshots',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;process.env.ADMIN_TOKEN_SECRET='payroll-test-secret';
 const {registerPayrollRoutes}=await import('../dist/payroll.js');
 const {signAdminToken}=await import('../dist/admin-auth.js');
 const {db:authPool}=await import('../dist/db.js');
 const pool=new pg.Pool({connectionString:url});const app=Fastify();registerPayrollRoutes(app,pool);
 const company=randomUUID(),other=randomUUID(),admin=randomUUID(),employee=randomUUID(),monthly=randomUUID(),branch=randomUUID(),branch2=randomUUID();
 const headers={authorization:`Bearer ${signAdminToken({adminId:admin,email:'manager@example.test',companyId:company,role:'MANAGER',exp:Date.now()+600000})}`};
 const request=(method,path,payload,h=headers)=>app.inject({method,url:'/v1/admin/payroll/'+path,headers:h,payload});
 const ok=async(method,path,payload)=>{const r=await request(method,path,payload);assert.equal(r.statusCode,200,r.body);return r.json()};
 let hash,slip,shift;
 try{
  await pool.query(await readFile(new URL('../../../database/schema.sql',import.meta.url),'utf8'));
  await pool.query("insert into companies(id,name,country_code,timezone,currency) values($1,'Payroll <Test>','GB','Europe/London','GBP'),($2,'Other','GB','Europe/London','GBP')",[company,other]);
  await pool.query("insert into company_admins(id,company_id,email,password_hash,role) values($1,$2,$3,'test','MANAGER')",[admin,company,`${admin}@example.test`]);
  for(const id of [branch,branch2])await pool.query("insert into branches(id,company_id,name,timezone) values($1,$2,'Branch','Europe/London')",[id,company]);
  for(const [id,name] of [[employee,'Hourly'],[monthly,'Monthly']])await pool.query("insert into employees(id,company_id,employee_number,first_name,last_name,pin_hash) values($1,$2,$3,$4,'Tester','test')",[id,company,id,name]);
  for(const [id,type,hourly,salary] of [[employee,'HOURLY',10,null],[monthly,'MONTHLY',null,2000]]){
   await pool.query('insert into employee_compensation_profiles(company_id,employee_id,pay_type,hourly_rate,monthly_salary,currency) values($1,$2,$3,$4,$5,\'GBP\')',[company,id,type,hourly,salary]);
   await pool.query("insert into employee_compensation_history(company_id,employee_id,effective_from,pay_type,hourly_rate,monthly_salary,currency) values($1,$2,'2020-01-01',$3,$4,$5,'GBP')",[company,id,type,hourly,salary]);
  }
  const makeShift=async(b,date,start=8,end=16)=>{const r=await pool.query("insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,published,break_minutes) values($1,$2,$3,$4,$5,true,0) returning id",[company,employee,b,`2020-10-${date}T${start}:00Z`,`2020-10-${date}T${end}:00Z`]);return r.rows[0].id};
  shift=await makeShift(branch,'05','08','16');const second=await makeShift(branch2,'06','08','16');
  await t.test('auth, open months and missing attendance fail closed',async()=>{
   assert.equal((await request('GET','preview?month=2020-10',undefined,{})).statusCode,401);
   const d=await ok('GET','preview?month=2020-10');assert.ok(d.blockers.includes('ATTENDANCE_EXCEPTION_REVIEW_REQUIRED'));
   const open=await ok('GET','preview?month=2099-01');assert.ok(open.blockers.includes('PAYROLL_MONTH_STILL_OPEN'));
   assert.equal((await request('GET','preview?month=2020-99')).statusCode,400);
  });
  for(const id of [shift,second])await pool.query("insert into payroll_shift_reviews(company_id,shift_id,employee_id,decision,reviewed_by) values($1,$2,$3,'WORKED',$4)",[company,id,employee,admin]);
  const adjustment=(await pool.query("insert into payroll_draft_adjustments(company_id,employee_id,payroll_month,kind,amount,currency,reason,created_by) values($1,$2,'2020-10-01','BONUS',50,'GBP','Test bonus',$3) returning id",[company,employee,admin])).rows[0].id;
  await t.test('pending adjustments block; approved adjustments reconcile across branches without breaks',async()=>{
   assert.ok((await ok('GET','preview?month=2020-10')).blockers.includes('PAYROLL_ADJUSTMENT_REVIEW_REQUIRED'));
   await pool.query("update payroll_draft_adjustments set review_status='APPROVED' where id=$1",[adjustment]);
   await pool.query("insert into payroll_draft_adjustments(company_id,employee_id,payroll_month,kind,amount,currency,reason,created_by,review_status) values($1,$2,'2020-10-01','DEDUCTION',20,'GBP','Test deduction',$3,'APPROVED')",[company,employee,admin]);
   const d=await ok('GET','preview?month=2020-10');assert.deepEqual(d.blockers,[]);assert.equal(d.approvalAllowed,true);
   const e=d.employees.find(e=>e.employeeId===employee);assert.equal(e.regularHours,16);assert.equal(e.regularPay,160);assert.equal(e.grossPay,'210.00');assert.equal(e.netPay,'190.00');
   assert.equal(d.employees.find(e=>e.employeeId===monthly).netPay,'2000.00');hash=d.previewHash;
  });
  await t.test('stale preview cannot approve and cancelled shifts are excluded',async()=>{
   await pool.query("update payroll_shift_reviews set decision='CANCELLED' where shift_id=$1",[shift]);
   const stale=await request('POST','approve',{month:'2020-10',previewHash:hash});assert.equal(stale.statusCode,409);assert.equal(stale.json().error,'PAYROLL_CHANGED_REFRESH_PREVIEW');
   assert.equal((await ok('GET','preview?month=2020-10')).employees.find(e=>e.employeeId===employee).regularHours,8);
   await pool.query("update payroll_shift_reviews set decision='WORKED' where shift_id=$1",[shift]);
  });
  await t.test('negative earnings, currency mismatch and missing history block approval',async()=>{
   const d=(await pool.query("insert into payroll_draft_adjustments(company_id,employee_id,payroll_month,kind,amount,currency,reason,created_by,review_status) values($1,$2,'2020-10-01','DEDUCTION',9999,'GBP','Excess deduction',$3,'APPROVED') returning id",[company,employee,admin])).rows[0].id;
   assert.ok((await ok('GET','preview?month=2020-10')).blockers.includes('DEDUCTIONS_EXCEED_GROSS_PAY'));
   await pool.query('update payroll_draft_adjustments set currency=\'KES\' where id=$1',[d]);
   assert.ok((await ok('GET','preview?month=2020-10')).blockers.includes('ADJUSTMENT_CURRENCY_MISMATCH'));
   await pool.query('delete from payroll_draft_adjustments where id=$1',[d]);
   await pool.query("update employee_compensation_profiles set pay_type='MONTHLY',hourly_rate=null,monthly_salary=999 where company_id=$1 and employee_id=$2",[company,employee]);
   assert.ok((await ok('GET','preview?month=2020-10')).blockers.includes('MONTH_START_COMPENSATION_HISTORY_REQUIRED'));
   await pool.query("update employee_compensation_profiles set pay_type='HOURLY',hourly_rate=10,monthly_salary=null where company_id=$1 and employee_id=$2",[company,employee]);
  });
  await t.test('approved overtime replaces hourly base pay and rejects mismatched currency',async()=>{
   const ot=(await pool.query("insert into shift_overtime_approvals(company_id,shift_id,employee_id,week_start,overtime_hours,pay_method,approved_hourly_rate,currency,approved_by) values($1,$2,$3,'2020-10-05',2,'CUSTOM_HOURLY',15,'GBP',$4) returning id",[company,second,employee,admin])).rows[0].id;
   const e=(await ok('GET','preview?month=2020-10')).employees.find(e=>e.employeeId===employee);assert.equal(e.regularHours,14);assert.equal(e.regularPay,140);assert.equal(e.overtimePay,30);assert.equal(e.netPay,'200.00');
   await pool.query("update shift_overtime_approvals set currency='KES' where id=$1",[ot]);
   assert.ok((await ok('GET','preview?month=2020-10')).blockers.includes('OVERTIME_APPROVAL_RECONCILIATION_REQUIRED'));
   await pool.query('delete from shift_overtime_approvals where id=$1',[ot]);
  });
  await t.test('audit failure rolls back the entire run and all employee snapshots',async()=>{
   const hash=(await ok('GET','preview?month=2020-10')).previewHash;
   await pool.query(`create function payroll_test_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action='APPROVE_PAYROLL' then raise exception 'TEST_AUDIT_FAILURE'; end if; return NEW; end $$; create trigger payroll_test_audit_failure before insert on audit_log for each row execute function payroll_test_audit_failure()`);
   try{const r=await request('POST','approve',{month:'2020-10',previewHash:hash});assert.equal(r.statusCode,500);assert.equal((await pool.query('select 1 from payroll_runs where company_id=$1',[company])).rowCount,0);assert.equal((await pool.query('select 1 from employee_payroll_snapshots where company_id=$1',[company])).rowCount,0)}finally{await pool.query('drop trigger payroll_test_audit_failure on audit_log; drop function payroll_test_audit_failure()')}
  });
  await t.test('approval is atomic and concurrent duplicate submissions are idempotent',async()=>{
   hash=(await ok('GET','preview?month=2020-10')).previewHash;
   const responses=await Promise.all([request('POST','approve',{month:'2020-10',previewHash:hash}),request('POST','approve',{month:'2020-10',previewHash:hash})]);
   for(const r of responses)assert.equal(r.statusCode,200,r.body);assert.equal(responses[0].json().runId,responses[1].json().runId);
   assert.equal((await pool.query('select id from payroll_runs where company_id=$1',[company])).rowCount,1);
   assert.equal((await pool.query('select id from employee_payroll_snapshots where company_id=$1',[company])).rowCount,2);
   const stored=(await pool.query('select total_earnings,net_pay from employee_payroll_snapshots where company_id=$1 and employee_id=$2',[company,employee])).rows[0];assert.equal(stored.total_earnings,'210.00');assert.equal(stored.net_pay,'190.00');
   slip=(await ok('GET','payslips?month=2020-10')).payslips.find(s=>s.data.employeeId===employee);
   assert.ok((await ok('GET','preview?month=2020-10')).blockers.includes('PAYROLL_ALREADY_APPROVED'));
  });
  await t.test('tenant isolation and immutable snapshots survive source edits',async()=>{
   const foreign={authorization:`Bearer ${signAdminToken({email:'other@example.test',companyId:other,role:'MANAGER',exp:Date.now()+600000})}`};
   assert.equal((await request('GET',`payslips/${slip.id}/download`,undefined,foreign)).statusCode,404);
   await assert.rejects(pool.query('update employee_payroll_snapshots set regular_pay=1 where id=$1',[slip.id]),/FINALISED_PAYROLL_IMMUTABLE/);
   await pool.query('update employee_compensation_profiles set hourly_rate=99 where company_id=$1 and employee_id=$2',[company,employee]);
   const saved=(await ok('GET','payslips?month=2020-10')).payslips.find(s=>s.id===slip.id);assert.equal(saved.data.netPay,'190.00');
   const pdf=await request('GET',`payslips/${slip.id}/download`);assert.equal(pdf.statusCode,200);assert.match(pdf.headers['content-type'],/application\/pdf/);assert.match(pdf.headers['content-disposition'],/attachment/);assert.equal(pdf.rawPayload.subarray(0,5).toString(),'%PDF-');
  });
 }finally{await app.close();await pool.end();await authPool.end()}
});
