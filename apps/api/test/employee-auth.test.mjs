import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { registerEmployeeRoutes } from '../dist/employee-routes.js';
const companyId='11111111-1111-4111-8111-111111111111',employeeId='22222222-2222-4222-8222-222222222222';
const hash=s=>createHash('sha256').update(s).digest('hex');
const login={companyId,employeeNumber:'1043',pin:'1234'};
function setup(){
 const app=Fastify();const calls=[],sessions=new Map();let active=true;
 const db={query:async(sql,params=[])=>{calls.push({sql,params});let rows=[];
  if(sql.startsWith('select e.id,e.employee_number')&&sql.includes('crypt(')){if(active&&params[0]===companyId&&params[1]==='1043'&&params[2]==='1234')rows=[{id:employeeId,firstName:'Dark',pin_hash:'stored-pin-hash'}]}
  else if(sql.startsWith('insert into employee_sessions'))sessions.set(params[0],params);
  else if(sql.startsWith('select e.id as')){if(active&&sessions.has(params[0]))rows=[{employeeId,companyId}]}
  else if(sql.startsWith('select e.id,e.employee_number'))rows=[{id:employeeId,firstName:'Dark'}];
  else if(sql.startsWith('select s.id'))rows=[{id:'shift-1'}];
  else if(sql.includes('delete from employee_sessions where token_hash'))sessions.delete(params[0]);
  return{rows,rowCount:rows.length};
 }};
 registerEmployeeRoutes(app,db);return{app,calls,sessions,deactivate:()=>{active=false}};
}
test('login returns opaque token, stores hashes, scopes credentials and avoids PIN hash disclosure',async(t)=>{
 const{app,calls,sessions}=setup();t.after(()=>app.close());const response=await app.inject({method:'POST',url:'/v1/employee/login',payload:login});assert.equal(response.statusCode,200);const data=response.json();assert.match(data.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(data.employee.pin_hash,undefined);assert.equal(response.headers['cache-control'],'no-store');const stored=sessions.get(hash(data.token));assert.equal(stored[1],companyId);assert.equal(stored[2],employeeId);assert.equal(stored[3],hash('stored-pin-hash'));assert.deepEqual(calls[0].params,[companyId,'1043','1234']);
});
test('invalid PIN and other company cannot sign in',async(t)=>{const{app}=setup();t.after(()=>app.close());for(const payload of[{...login,pin:'9999'},{...login,companyId:'33333333-3333-4333-8333-333333333333'}])assert.equal((await app.inject({method:'POST',url:'/v1/employee/login',payload})).statusCode,401)});
test('concurrent attempts are limited before database queries',async(t)=>{const{app,calls}=setup();t.after(()=>app.close());const responses=await Promise.all(Array.from({length:12},()=>app.inject({method:'POST',url:'/v1/employee/login',payload:{...login,pin:'9999'}})));assert.equal(responses.filter(r=>r.statusCode===429).length,2);assert.equal(calls.length,10);assert.ok(responses.find(r=>r.statusCode===429).headers['retry-after'])});
test('employee reads own shifts, admin and malformed tokens fail, logout revokes token',async(t)=>{const{app,calls}=setup();t.after(()=>app.close());const response=await app.inject({method:'POST',url:'/v1/employee/login',payload:login});const token=response.json().token,headers={authorization:`Bearer ${token}`};for(const authorization of[token,'Bearer admin.payload','Bearer '+token+'.extra'])assert.equal((await app.inject({url:'/v1/employee/me',headers:{authorization}})).statusCode,401);assert.equal((await app.inject({url:'/v1/employee/shifts?companyId=other&employeeId=other',headers})).statusCode,200);const shifts=calls.find(c=>c.sql.startsWith('select s.id'));assert.deepEqual(shifts.params,[employeeId,companyId]);assert.equal((await app.inject({method:'POST',url:'/v1/employee/logout',headers})).statusCode,200);assert.equal((await app.inject({url:'/v1/employee/me',headers})).statusCode,401)});
test('deactivated worker loses both profile and shift access',async(t)=>{const{app,deactivate}=setup();t.after(()=>app.close());const response=await app.inject({method:'POST',url:'/v1/employee/login',payload:login});const headers={authorization:`Bearer ${response.json().token}`};deactivate();for(const url of['/v1/employee/me','/v1/employee/shifts'])assert.equal((await app.inject({url,headers})).statusCode,401)});
