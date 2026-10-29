import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createHmac} from 'node:crypto';
import {registerRotaOccurrenceRoutes} from './dist/rota-occurrences.js';

const companyId='11111111-1111-4111-8111-111111111111';
const recurrenceId='22222222-2222-4222-8222-222222222222';
const occurrenceId='33333333-3333-4333-8333-333333333333';
const templateId='44444444-4444-4444-8444-444444444444';
const employeeId='55555555-5555-4555-8555-555555555555';
const branchId='66666666-6666-4666-8666-666666666666';
process.env.ADMIN_TOKEN_SECRET='recurrence-integration-test-secret';
function token(){
 const body=Buffer.from(JSON.stringify({companyId,email:'test@example.org',role:'MANAGER',exp:Date.now()+60000})).toString('base64url');
 return body+'.'+createHmac('sha256',process.env.ADMIN_TOKEN_SECRET).update(body).digest('base64url');
}
function mockDb({conflict=false,absence=false}={}){
 const sql=[],state={shifts:0,commits:0,rollbacks:0};
 const client={
  async query(query){
   const q=String(query);sql.push(q);
   if(q==='COMMIT'){state.commits++;return {rowCount:0,rows:[]}}
   if(q==='ROLLBACK'){state.rollbacks++;state.shifts=0;return {rowCount:0,rows:[]}}
   if(q.includes('from rota_recurrences r join rota_templates'))return {rowCount:1,rows:[{
    id:recurrenceId,period_start:'2026-11-02',end_mode:'UNTIL_STOPPED',end_date:null,
    cadence:'WEEKLY',status:'ACTIVE',template_id:templateId,approved_version:1,branch_id:branchId,timezone:'UTC'
   }]};
   if(q.includes('insert into rota_occurrences'))return {rowCount:1,rows:[{id:occurrenceId}]};
   if(q.includes('from rota_template_shifts'))return {rowCount:2,rows:[
    {employee_id:employeeId,day_offset:0,start_time:'07:00:00',end_time:'15:00:00',end_day_offset:0,break_minutes:60},
    {employee_id:employeeId,day_offset:1,start_time:'07:00:00',end_time:'15:00:00',end_day_offset:0,break_minutes:60}
   ]};
   if(q.includes('as starts'))return {rowCount:1,rows:[{starts:new Date('2026-11-02T07:00:00Z'),ends:new Date('2026-11-02T15:00:00Z')}]};
   if(q.includes('from employees e left join'))return {rowCount:1,rows:[{id:employeeId}]};
   if(q.includes('select 1 from shifts'))return {rowCount:conflict&&state.shifts>0?1:0,rows:[]};
   if(q.includes('from employee_unavailability'))return {rowCount:absence&&state.shifts>0?1:0,rows:[]};
   if(q.includes('insert into shifts')){state.shifts++;return {rowCount:1,rows:[]}}
   return {rowCount:1,rows:[]};
  },release(){}
 };
 return {db:{connect:async()=>client},state,sql};
}
async function runCase(options){
 const m=mockDb(options),app=Fastify();
 registerRotaOccurrenceRoutes(app,m.db);
 const res=await app.inject({method:'POST',url:'/v1/admin/rota-recurrences/'+recurrenceId+'/generate-next',headers:{authorization:'Bearer '+token()}});
 await app.close();return {...m,response:res.json(),status:res.statusCode};
}
test('complete recurrence commits drafts and advances the period',async()=>{
 const r=await runCase();
 assert.equal(r.status,200);assert.equal(r.response.created,2);
 assert.equal(r.state.commits,1);assert.equal(r.state.shifts,2);
 assert.ok(r.sql.some(q=>q.includes('next_period_start=$2')));
});
test('overlapping shift rolls back every draft and does not advance',async()=>{
 const r=await runCase({conflict:true});
 assert.equal(r.status,409);assert.equal(r.response.error,'ROTA_PERIOD_INCOMPLETE');
 assert.equal(r.state.rollbacks,1);assert.equal(r.state.shifts,0);
 assert.ok(!r.sql.some(q=>q.includes('next_period_start=$2')));
});
test('employee absence rolls back every draft and preserves retry period',async()=>{
 const r=await runCase({absence:true});
 assert.equal(r.status,409);assert.equal(r.response.error,'ROTA_PERIOD_INCOMPLETE');
 assert.equal(r.state.rollbacks,1);assert.equal(r.state.shifts,0);
});
