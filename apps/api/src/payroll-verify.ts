import {registerSupportRoutes,supportStatus} from './support.js';
// Staging-only deployment check. All fixtures and approvals are rolled back.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {registerPayrollRoutes} from './payroll.js';
import {signAdminToken} from './admin-auth.js';
export async function verifyStagingPayroll(pool:Pick<Pool,'connect'>){
 const c=await pool.connect();const app=Fastify();
 try{
  const database=(await c.query('select current_database() as name')).rows[0].name;
  assert.equal(database,'attendra_staging_db','Payroll deployment verification is restricted to the staging database');
  await c.query('BEGIN');
  const company=randomUUID(),admin=randomUUID(),employee=randomUUID(),branch=randomUUID(),shift=randomUUID();
  await c.query("insert into companies(id,name,country_code,timezone,currency) values($1,'Temporary payroll verification','GB','Europe/London','GBP')",[company]);
  await c.query("insert into company_admins(id,company_id,email,password_hash,role) values($1,$2,'verification@example.invalid','unusable','MANAGER')",[admin,company]);
  await c.query("insert into branches(id,company_id,name,timezone) values($1,$2,'Verification','Europe/London')",[branch,company]);
  await c.query("insert into employees(id,company_id,employee_number,first_name,last_name,pin_hash) values($1,$2,'VERIFY','Payroll','Verification','unusable')",[employee,company]);
  await c.query("insert into employee_compensation_profiles(company_id,employee_id,pay_type,hourly_rate,currency) values($1,$2,'HOURLY',10,'GBP')",[company,employee]);
  await c.query("insert into employee_compensation_history(company_id,employee_id,effective_from,pay_type,hourly_rate,currency) values($1,$2,'2020-01-01','HOURLY',10,'GBP')",[company,employee]);
  await c.query("insert into shifts(id,company_id,employee_id,branch_id,starts_at,ends_at,published) values($1,$2,$3,$4,'2020-10-05T08:00Z','2020-10-05T16:00Z',true)",[shift,company,employee,branch]);
  await c.query("insert into payroll_shift_reviews(company_id,employee_id,shift_id,decision,reviewed_by) values($1,$2,$3,'WORKED',$4)",[company,employee,shift,admin]);
  await c.query("insert into payroll_draft_adjustments(company_id,employee_id,payroll_month,kind,amount,currency,reason,created_by,review_status) values($1,$2,'2020-10-01','BONUS',50,'GBP','Verification bonus',$3,'APPROVED'),($1,$2,'2020-10-01','DEDUCTION',20,'GBP','Verification deduction',$3,'APPROVED')",[company,employee,admin]);
  // Route transactions run inside an outer rollback-only transaction.
  const client:any={query:async(sql:any,values:any)=>{
   if(typeof sql==='string'&&sql.startsWith('BEGIN'))return c.query('SAVEPOINT payroll_verification');
   if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT payroll_verification');
   if(sql==='ROLLBACK')return c.query('ROLLBACK TO SAVEPOINT payroll_verification');
   return c.query(sql,values);
  },release:()=>{}};
  registerPayrollRoutes(app,{query:client.query,connect:async()=>client} as any);
  registerSupportRoutes(app,{query:client.query,connect:async()=>client} as any);
  const headers={authorization:`Bearer ${signAdminToken({adminId:admin,email:'verification@example.invalid',companyId:company,role:'MANAGER',exp:Date.now()+60000})}`};
  const call=async(method:'GET'|'POST',path:string,payload?:any)=>{const r=await app.inject({method,url:'/v1/admin/payroll/'+path,headers,payload});assert.equal(r.statusCode,200,r.body);return r};
  const preview=(await call('GET','preview?month=2020-10')).json();assert.equal(preview.approvalAllowed,true);assert.equal(preview.employees[0].netPay,'110.00');
  await call('POST','approve',{month:'2020-10',previewHash:preview.previewHash});
  const slips=(await call('GET','payslips?month=2020-10')).json();assert.equal(slips.payslips.length,1);assert.equal(slips.payslips[0].data.netPay,'110.00');
  const pdf=await call('GET',`payslips/${slips.payslips[0].id}/download`);assert.equal(pdf.rawPayload.subarray(0,5).toString(),'%PDF-');
  if(supportStatus().enabled){
   const support=await app.inject({method:'POST',url:'/v1/admin/support/diagnostics',headers,payload:{topic:'rota',month:'2020-10'}});
   assert.equal(support.statusCode,200,support.body);assert.equal(support.json().readOnly,true);assert.equal(support.json().context.schedule.publishedShifts,1);
   console.log(JSON.stringify({event:'support-staging-verification',status:'passed',database,checks:['manager-auth','read-only-diagnostics','company-scope'],aiConfigured:supportStatus().aiConfigured}));
  }
  await c.query('ROLLBACK');
  console.log(JSON.stringify({event:'payroll-staging-verification',status:'passed',database,checks:['preview','approval','snapshot','adjustments','pdf-download'],fixtures:'rolled-back'}));
 }catch(error){await c.query('ROLLBACK');throw error}finally{await app.close();c.release()}
}
