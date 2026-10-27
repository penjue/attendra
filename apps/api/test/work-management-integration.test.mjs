import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';

const url=process.env.SCHEDULING_TEST_DATABASE_URL;
test('work management: authentication, tenant isolation and task/incident transitions',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;
 process.env.ADMIN_TOKEN_SECRET='work-management-integration-secret';
 const [{registerWorkManagementRoutes},{registerEmployeeRoutes},{signAdminToken}]=await Promise.all([
  import('../dist/work-management.js'),import('../dist/employee-routes.js'),import('../dist/admin-auth.js')
 ]);
 const pool=new pg.Pool({connectionString:url}),app=Fastify();
 registerWorkManagementRoutes(app,pool);registerEmployeeRoutes(app,pool);
 const company=randomUUID(),other=randomUUID(),employee=randomUUID(),outsider=randomUUID();
 const token='w'.repeat(43);
 const manager={authorization:`Bearer ${signAdminToken({email:'manager@example.test',companyId:company,role:'MANAGER',exp:Date.now()+600000})}`};
 const employeeHeaders={authorization:`Bearer ${token}`};
 const send=(method,path,payload,headers=manager)=>app.inject({method,url:path,payload,headers});
 try{
  const schema=await readFile(new URL('../../../database/schema.sql',import.meta.url),'utf8');
  await pool.query(schema);await pool.query(schema);
  await pool.query("INSERT INTO companies(id,name,country_code,timezone,currency) VALUES($1,'Work test','GB','Europe/London','GBP'),($2,'Other work test','KE','Africa/Nairobi','KES')",[company,other]);
  for(const [id,c,n] of [[employee,company,'101'],[outsider,other,'202']]){
   await pool.query("INSERT INTO employees(id,company_id,employee_number,first_name,last_name,pin_hash) VALUES($1,$2,$3,'Test','Worker',crypt('1234',gen_salt('bf')))",[id,c,n]);
  }
  const pin=(await pool.query('SELECT pin_hash FROM employees WHERE id=$1',[employee])).rows[0].pin_hash;
  await pool.query("INSERT INTO employee_sessions(token_hash,company_id,employee_id,credential_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",[createHash('sha256').update(token).digest('hex'),company,employee,createHash('sha256').update(pin).digest('hex')]);
  await t.test('unauthenticated access denied',async()=>{
   assert.equal((await send('GET','/v1/admin/tasks',undefined,{})).statusCode,401);
   assert.equal((await send('GET','/v1/employee/tasks',undefined,{})).statusCode,401);
  });
  await t.test('manager cannot assign tasks across companies',async()=>{
   const r=await send('POST','/v1/admin/tasks',{employeeId:outsider,title:'Forbidden'});
   assert.equal(r.statusCode,404,r.body);
  });
  let taskId;
  await t.test('manager assigns and employee completes own task',async()=>{
   const r=await send('POST','/v1/admin/tasks',{employeeId:employee,title:'Daily check'});
   assert.equal(r.statusCode,201,r.body);taskId=r.json().task.id;
   const list=await send('GET','/v1/employee/tasks',undefined,employeeHeaders);
   assert.equal(list.statusCode,200,list.body);assert.equal(list.json().tasks.length,1);
   assert.equal((await send('PATCH',`/v1/employee/tasks/${taskId}/status`,{status:'CANCELLED'},employeeHeaders)).statusCode,400);
   assert.equal((await send('PATCH',`/v1/employee/tasks/${taskId}/status`,{status:'IN_PROGRESS'},employeeHeaders)).statusCode,200);
   assert.equal((await send('PATCH',`/v1/employee/tasks/${taskId}/status`,{status:'COMPLETED'},employeeHeaders)).statusCode,200);
   assert.equal((await send('PATCH',`/v1/employee/tasks/${taskId}/status`,{status:'IN_PROGRESS'},employeeHeaders)).statusCode,404);
  });
  let incidentId;
  await t.test('employee submits incident; manager reviews without changing original',async()=>{
   const occurredAt=new Date().toISOString();
   const r=await send('POST','/v1/employee/incidents',{category:'SAFETY',description:'Spilled liquid near the entrance',occurredAt},employeeHeaders);
   assert.equal(r.statusCode,201,r.body);incidentId=r.json().incident.id;
   const list=await send('GET','/v1/admin/incidents');
   assert.equal(list.statusCode,200,list.body);assert.equal(list.json().incidents[0].id,incidentId);
   assert.equal((await send('PATCH',`/v1/admin/incidents/${incidentId}/status`,{status:'UNDER_REVIEW'})).statusCode,200);
   assert.equal((await send('PATCH',`/v1/admin/incidents/${incidentId}/status`,{status:'RESOLVED'})).statusCode,200);
   const row=(await pool.query('SELECT description,status FROM employee_incidents WHERE id=$1',[incidentId])).rows[0];
   assert.equal(row.description,'Spilled liquid near the entrance');assert.equal(row.status,'RESOLVED');
  });
  await t.test('invalid incident data rejected',async()=>{
   const r=await send('POST','/v1/employee/incidents',{category:'SAFETY',description:'short',occurredAt:new Date().toISOString()},employeeHeaders);
   assert.equal(r.statusCode,400,r.body);
  });
 }finally{
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,other]]);
  await app.close();await pool.end();
 }
});
