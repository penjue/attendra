import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

const url=process.env.SCHEDULING_TEST_DATABASE_URL;
const script=new URL('./dist/rota-worker.js',import.meta.url).pathname;
const id=()=>randomUUID();

test('scheduled worker generates unpublished PostgreSQL drafts exactly once per period',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const companyId=id(),branchId=id(),employeeId=id(),templateId=id(),recurrenceId=id();
 const run=()=>spawnSync(process.execPath,[script],{encoding:'utf8',timeout:20000,env:{
  ...process.env,DATABASE_URL:url,ADMIN_TOKEN_SECRET:'worker-integration-test-secret',
  ATTENDRA_ROTA_WORKER_ENABLED:'true',ATTENDRA_ROTA_WORKER_ENV:'staging'
 }});
 try{
  await pool.query("insert into companies(id,name,country_code,timezone,currency) values($1,'Worker Test','GB','UTC','GBP')",[companyId]);
  await pool.query("insert into branches(id,company_id,name,timezone) values($1,$2,'Worker Branch','UTC')",[branchId,companyId]);
  await pool.query("insert into employees(id,company_id,employee_number,first_name,last_name,pin_hash) values($1,$2,$3,'Worker','Tester','test')",[employeeId,companyId,'worker-'+employeeId]);
  await pool.query("insert into rota_templates(id,company_id,branch_id,period_type,anchor_start_date,timezone,status,approved_version) values($1,$2,$3,'WEEKLY','2026-10-19','UTC','APPROVED',1)",[templateId,companyId,branchId]);
  await pool.query("insert into rota_template_shifts(template_id,employee_id,day_offset,start_local_time,end_local_time,break_minutes) values($1,$2,0,'07:00','15:00',60)",[templateId,employeeId]);
  await pool.query("insert into rota_recurrences(id,template_id,cadence,end_mode,next_period_start) values($1,$2,'WEEKLY','UNTIL_STOPPED','2026-10-26')",[recurrenceId,templateId]);
  const first=run();
  assert.equal(first.status,0,first.stderr+'\n'+first.stdout);
  const shifts=await pool.query("select published,rota_occurrence_id from shifts where company_id=$1",[companyId]);
  assert.equal(shifts.rowCount,1);
  assert.equal(shifts.rows[0].published,false);
  assert.ok(shifts.rows[0].rota_occurrence_id);
  const occurrence=await pool.query("select period_start::text as day,status from rota_occurrences where recurrence_id=$1",[recurrenceId]);
  assert.equal(occurrence.rowCount,1);
  assert.equal(occurrence.rows[0].day,'2026-10-26');
  const next=await pool.query("select next_period_start::text as day from rota_recurrences where id=$1",[recurrenceId]);
  assert.equal(next.rows[0].day,'2026-11-02');
  const second=run();
  assert.equal(second.status,0,second.stderr+'\n'+second.stdout);
  const after=await pool.query("select count(*)::int as n from shifts where company_id=$1",[companyId]);
  assert.equal(after.rows[0].n,1,'repeat invocation must not duplicate an already generated period');
 }finally{
  await pool.query('delete from rota_template_shifts where template_id=$1',[templateId]);
  await pool.query('delete from companies where id=$1',[companyId]);
  await pool.end();
 }
});
