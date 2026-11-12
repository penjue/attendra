import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
const url=process.env.SCHEDULING_TEST_DATABASE_URL;
test('read-only support: company isolation, employee privacy, provider consent and safe failure',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;process.env.ADMIN_TOKEN_SECRET='support-test-secret';process.env.ATTENDRA_SUPPORT_ENABLED='true';process.env.ATTENDRA_SUPPORT_OPENAI_KEY='test-key-not-real';
 const {registerSupportRoutes,readSupportSnapshot,openAiSupport,redactSupportText}=await import('../dist/support.js');
 const {signAdminToken}=await import('../dist/admin-auth.js');const {db:authPool}=await import('../dist/db.js');
 const pool=new pg.Pool({connectionString:url});const app=Fastify();const calls=[];let providerHook=async()=>{};
 registerSupportRoutes(app,pool,async input=>{calls.push(input);await providerHook();return 'Review the published shifts in the app. No records were changed.'});
 const company=randomUUID(),other=randomUUID(),admin=randomUUID(),foreignAdmin=randomUUID(),employee=randomUUID(),colleague=randomUUID(),foreignEmployee=randomUUID(),branch=randomUUID(),otherBranch=randomUUID();
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const adminHeaders=(id,co)=>({authorization:`Bearer ${signAdminToken({adminId:id,email:'support@example.invalid',companyId:co,role:'MANAGER',exp:Date.now()+600000})}`});
 const manager=adminHeaders(admin,company),foreign=adminHeaders(foreignAdmin,other);let employeeHeaders;
 const call=(role,path,body,headers=manager)=>app.inject({method:body?'POST':'GET',url:`/v1/${role}/support/${path}`,headers,payload:body});
 const ok=async(role,path,body,headers=manager)=>{const r=await call(role,path,body,headers);assert.equal(r.statusCode,200,r.body);return r.json()};
 try{
  await pool.query(await readFile(new URL('../../../database/schema.sql',import.meta.url),'utf8'));
  for(const id of [company,other])await pool.query("insert into companies(id,name,country_code,timezone,currency) values($1,'Support test','GB','Europe/London','GBP')",[id]);
  for(const [id,co]of [[admin,company],[foreignAdmin,other]])await pool.query("insert into company_admins(id,company_id,email,password_hash,role) values($1,$2,$3,'SECRET_HASH','MANAGER')",[id,co,id+'@example.invalid']);
  for(const [id,co]of [[employee,company],[colleague,company],[foreignEmployee,other]])await pool.query("insert into employees(id,company_id,employee_number,first_name,last_name,pin_hash) values($1,$2,$3,'PRIVATE_NAME','Test','SECRET_PIN_HASH')",[id,co,id]);
  for(const[id,co]of [[branch,company],[otherBranch,other]])await pool.query("insert into branches(id,company_id,name,timezone) values($1,$2,'Private branch','Europe/London')",[id,co]);
  for(const[id,co,b]of [[employee,company,branch],[colleague,company,branch],[foreignEmployee,other,otherBranch]])await pool.query("insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,published) values($1,$2,$3,'2020-10-05T08:00Z','2020-10-05T16:00Z',true)",[co,id,b]);
  const token=randomBytes(32).toString('base64url');await pool.query("insert into employee_sessions(token_hash,company_id,employee_id,credential_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')",[hash(token),company,employee,hash('SECRET_PIN_HASH')]);employeeHeaders={authorization:`Bearer ${token}`};
  await t.test('requires an active correctly scoped login and strict selectors',async()=>{
   assert.equal((await call('admin','status',undefined,{})).statusCode,401);
   assert.equal((await call('admin','status',undefined,employeeHeaders)).statusCode,401);
   assert.equal((await call('employee','status',undefined,manager)).statusCode,401);
   assert.equal((await call('admin','status',undefined,adminHeaders(admin,other))).statusCode,401);
   assert.equal((await call('admin','diagnostics',{topic:'rota',companyId:other})).statusCode,400);
   assert.equal((await call('employee','diagnostics',{topic:'rota',employeeId:colleague},employeeHeaders)).statusCode,400);
   await pool.query('update company_admins set active=false where id=$1',[admin]);assert.equal((await call('admin','status')).statusCode,401);await pool.query('update company_admins set active=true where id=$1',[admin]);
  });
  await t.test('employees see their own counts; managers see company aggregates without names or credentials',async()=>{
   const own=await ok('employee','diagnostics',{topic:'rota',month:'2020-10'},employeeHeaders);assert.equal(own.context.schedule.publishedShifts,1);assert.equal(own.context.draftShifts,undefined);
   const management=await ok('admin','diagnostics',{topic:'rota',month:'2020-10'});assert.equal(management.context.schedule.publishedShifts,2);
   const otherData=await ok('admin','diagnostics',{topic:'rota',month:'2020-10'},foreign);assert.equal(otherData.context.schedule.publishedShifts,1);
   for(const data of [own,management,otherData])for(const secret of ['PRIVATE_NAME','SECRET_PIN_HASH','SECRET_HASH',employee,colleague,foreignEmployee])assert.equal(JSON.stringify(data).includes(secret),false);
  });
  await t.test('database enforces read-only transactions and record counts remain unchanged',async()=>{
   const hostile={connect:async()=>{const c=await pool.connect();return {query:async(sql,params)=>{if(sql.startsWith('select timezone'))return c.query('update employees set first_name=\'HACKED\' where id=$1',[employee]);return c.query(sql,params)},release:()=>c.release()}}};
   await assert.rejects(readSupportSnapshot(hostile,{companyId:company,id:employee,role:'employee'},'rota','2020-10'),e=>e.code==='25006');
   assert.equal((await pool.query('select first_name from employees where id=$1',[employee])).rows[0].first_name,'PRIVATE_NAME');
  });
  await t.test('AI requests require consent and diagnostic sharing is opt-in',async()=>{
   assert.equal((await call('admin','chat',{topic:'rota',message:'Help'})).statusCode,400);assert.equal(calls.length,0);
   await ok('admin','chat',{topic:'rota',message:'Help',consentToAi:true});assert.equal(calls.at(-1).diagnostics,null);
   await ok('employee','chat',{topic:'rota',month:'2020-10',message:'Help',consentToAi:true,shareDiagnostics:true},employeeHeaders);assert.equal(calls.at(-1).diagnostics.context.schedule.publishedShifts,1);
  });
  await t.test('missing provider key is explicit; diagnostics remain usable',async()=>{
   delete process.env.ATTENDRA_SUPPORT_OPENAI_KEY;
   assert.equal((await ok('admin','status')).aiConfigured,false);
   const r=await call('admin','chat',{message:'Help',consentToAi:true});assert.equal(r.statusCode,503);assert.equal(r.json().error,'SUPPORT_AI_NOT_CONFIGURED');
   assert.equal((await ok('admin','diagnostics',{topic:'payroll',month:'2020-10'})).readOnly,true);
   process.env.ATTENDRA_SUPPORT_OPENAI_KEY='test-key-not-real';
  });
  await t.test('provider contract has no tools, no response storage, bounded output and secret redaction',async()=>{
   const original=global.fetch;let sent;
   try{global.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Use Forgot password.'}]}]}),{status:200})};
    assert.equal(await openAiSupport({message:'password=secret sk-1234567890123456',history:[],knowledge:[],diagnostics:null}),'Use Forgot password.');assert.equal(sent.store,false);assert.equal(sent.max_output_tokens,800);assert.equal(sent.tools,undefined);assert.equal(JSON.stringify(sent).includes('password=secret'),false);assert.equal(JSON.stringify(sent).includes('sk-1234567890123456'),false);
    global.fetch=async()=>new Response('provider-secret-detail',{status:401});await assert.rejects(openAiSupport({message:'Hi',history:[],knowledge:[],diagnostics:null}),e=>e.code==='SUPPORT_PROVIDER_UNAVAILABLE'&&!e.message.includes('secret'));
    assert.equal(redactSupportText('Bearer sensitive.token'),'[redacted token]');
   }finally{global.fetch=original}
  });
  await t.test('access revoked during an AI call prevents returning the answer',async()=>{
   providerHook=async()=>{await pool.query('update company_admins set active=false where id=$1',[admin])};
   try{const r=await call('admin','chat',{message:'Help',consentToAi:true});assert.equal(r.statusCode,401);assert.equal(r.json().answer,undefined)}finally{await pool.query('update company_admins set active=true where id=$1',[admin]);providerHook=async()=>{}}
  });
  await t.test('request limits prevent extra provider calls',async()=>{
   const limited=Fastify();let count=0;registerSupportRoutes(limited,pool,async()=>{count++;return 'Guidance only'});
   try{const options={method:'POST',url:'/v1/admin/support/chat',headers:manager,payload:{message:'Help',consentToAi:true}};for(let i=0;i<20;i++)assert.equal((await limited.inject(options)).statusCode,200);const r=await limited.inject(options);assert.equal(r.statusCode,429);assert.ok(Number(r.headers['retry-after'])>0);assert.equal(count,20)}finally{await limited.close()}
  });
  await t.test('revoked employee sessions lose support access and disabled feature is hidden',async()=>{
   await pool.query('delete from employee_sessions where employee_id=$1',[employee]);assert.equal((await call('employee','status',undefined,employeeHeaders)).statusCode,401);
   process.env.ATTENDRA_SUPPORT_ENABLED='false';assert.equal((await call('admin','status')).statusCode,404);process.env.ATTENDRA_SUPPORT_ENABLED='true';
  });
 }finally{await app.close();await pool.end();await authPool.end();delete process.env.ATTENDRA_SUPPORT_OPENAI_KEY;delete process.env.ATTENDRA_SUPPORT_ENABLED}
});
