import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import {createHmac} from 'node:crypto';
const url=process.env.SCHEDULING_TEST_DATABASE_URL;
process.env.ADMIN_TOKEN_SECRET='recurrence-real-postgres-test-secret';
process.env.DATABASE_URL ||= url||'postgres://postgres:postgres@localhost:5432/attendra_test';
const {registerRotaOccurrenceRoutes}=await import('./dist/rota-occurrences.js');
const id=()=>crypto.randomUUID();
function token(companyId){
 const body=Buffer.from(JSON.stringify({companyId,email:'recurrence-test@example.com',role:'MANAGER',exp:Date.now()+60000})).toString('base64url');
 return body+'.'+createHmac('sha256',process.env.ADMIN_TOKEN_SECRET).update(body).digest('base64url');
}
test('real PostgreSQL recurrence generation commits drafts, rolls back conflicts, and retries safely',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const app=Fastify();registerRotaOccurrenceRoutes(app,pool);
 const companyId=id(),branchId=id(),employeeId=id(),templateId=id(),recurrenceId=id();
 try{
  await pool.query("insert into companies(id,name,country_code,timezone,currency) values($1,'Recurrence Test','GB','UTC','GBP')",[companyId]);
  await pool.query("insert into branches(id,company_id,name,timezone) values($1,$2,'Test Branch','UTC')",[branchId,companyId]);
  await pool.query("insert into employees(id,company_id,employee_number,first_name,last_name,pin_hash) values($1,$2,$3,'Rota','Tester','test')",[employeeId,companyId,'rota-'+employeeId]);
  await pool.query("insert into rota_templates(id,company_id,branch_id,period_type,anchor_start_date,timezone,status,approved_version) values($1,$2,$3,'WEEKLY','2099-01-05','UTC','APPROVED',1)",[templateId,companyId,branchId]);
  await pool.query("insert into rota_template_shifts(template_id,employee_id,day_offset,start_local_time,end_local_time,break_minutes) values($1,$2,0,'07:00','15:00',60),($1,$2,1,'07:00','15:00',60)",[templateId,employeeId]);
  await pool.query("insert into rota_recurrences(id,template_id,cadence,end_mode,next_period_start) values($1,$2,'WEEKLY','UNTIL_STOPPED','2099-01-12')",[recurrenceId,templateId]);
  const endpoint='/v1/admin/rota-recurrences/'+recurrenceId+'/generate-next';
  const send=()=>app.inject({method:'POST',url:endpoint,headers:{authorization:'Bearer '+token(companyId)}});
  const blocker=await pool.query("insert into employee_unavailability(company_id,employee_id,starts_at,ends_at,category) values($1,$2,'2099-01-13T00:00:00Z','2099-01-14T00:00:00Z','LEAVE') returning id",[companyId,employeeId]);
  const failed=await send();assert.equal(failed.statusCode,409,JSON.stringify(failed.json()));
  assert.equal(failed.json().error,'ROTA_PERIOD_INCOMPLETE');
  let count=await pool.query("select count(*)::int as n from shifts where company_id=$1",[companyId]);assert.equal(count.rows[0].n,0);
  count=await pool.query("select count(*)::int as n from rota_occurrences where recurrence_id=$1",[recurrenceId]);assert.equal(count.rows[0].n,0);
  await pool.query("delete from employee_unavailability where id=$1",[blocker.rows[0].id]);
  const success=await send();assert.equal(success.statusCode,200,JSON.stringify(success.json()));
  assert.equal(success.json().created,2);
  const drafts=await pool.query("select published,rota_occurrence_id from shifts where company_id=$1",[companyId]);
  assert.equal(drafts.rowCount,2);assert.ok(drafts.rows.every(s=>s.published===false&&s.rota_occurrence_id===success.json().occurrenceId));
  const next=await pool.query("select next_period_start::text as day from rota_recurrences where id=$1",[recurrenceId]);
  assert.equal(next.rows[0].day,'2099-01-19');
 }finally{
  await app.close();
  await pool.query('delete from companies where id=$1',[companyId]);
  await pool.end();
 }
});
