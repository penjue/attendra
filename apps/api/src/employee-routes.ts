import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function authenticateEmployee(db:Pick<Pool,'query'>,authorization:string|undefined):Promise<{employeeId:string;companyId:string}|null>{
 const token=authorization?.startsWith('Bearer ')?authorization.slice(7):'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const result=await db.query(`select e.id as "employeeId",e.company_id as "companyId" from employee_sessions s join employees e on e.id=s.employee_id and e.company_id=s.company_id where s.token_hash=$1 and s.expires_at>clock_timestamp() and e.active=true and s.credential_hash=encode(digest(e.pin_hash,'sha256'),'hex') limit 1`,[hash(token)]);
 return result.rows[0]??null;
}
export function registerEmployeeRoutes(app:FastifyInstance, db:Pick<Pool,'query'>){
 const attempts=new Map<string,{count:number;expires:number}>();
 app.addHook('preHandler',async(request,reply)=>{
  if(!request.url.startsWith('/v1/employee/'))return;
  reply.header('Cache-Control','no-store');
  if(request.url.split('?')[0]!=='/v1/employee/login')return;
  const now=Date.now();for(const[k,v]of attempts)if(v.expires<=now)attempts.delete(k);
  let state=attempts.get(request.ip);
  if(!state){if(attempts.size>=10000)return reply.code(429).header('Retry-After','900').send({ok:false,error:'TOO_MANY_LOGIN_ATTEMPTS'});state={count:0,expires:now+900000};attempts.set(request.ip,state)}
  if(state.count>=10)return reply.code(429).header('Retry-After',String(Math.ceil((state.expires-now)/1000))).send({ok:false,error:'TOO_MANY_LOGIN_ATTEMPTS'});
  state.count++;
 });
 const requireEmployee=async(req:any,reply:any)=>{
  const employee=await authenticateEmployee(db,req.headers.authorization);
  if(!employee)reply.code(401).send({ok:false,error:'EMPLOYEE_AUTH_REQUIRED'});
  return employee;
 };
app.post('/v1/employee/login',async(req,reply)=>{const p=z.object({companyId:z.uuid(),employeeNumber:z.string().trim().min(1).max(64),pin:z.string().regex(/^\d{4,12}$/)}).safeParse(req.body);if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_LOGIN_REQUEST'});const r=await db.query(`select e.id,e.employee_number as "employeeNumber",e.first_name as "firstName",e.last_name as "lastName",c.name as "companyName",e.pin_hash from employees e join companies c on c.id=e.company_id where e.company_id=$1 and e.employee_number=$2 and e.active=true and e.pin_hash=crypt($3,e.pin_hash) limit 1`,[p.data.companyId,p.data.employeeNumber,p.data.pin]);if(!r.rowCount)return reply.code(401).send({ok:false,error:'INVALID_EMPLOYEE_OR_PIN'});const {pin_hash,...e}=r.rows[0],exp=Date.now()+12*60*60*1000,token=randomBytes(32).toString('base64url');await db.query('delete from employee_sessions where expires_at<=now()');await db.query('insert into employee_sessions(token_hash,company_id,employee_id,credential_hash,expires_at) values($1,$2,$3,$4,$5)',[hash(token),p.data.companyId,e.id,hash(pin_hash),new Date(exp)]);return{ok:true,token,expiresAt:exp,employee:e}});
app.get('/v1/employee/me',async(req,reply)=>{const a=await requireEmployee(req,reply);if(!a)return;const r=await db.query(`select e.id,e.employee_number as "employeeNumber",e.first_name as "firstName",e.last_name as "lastName",c.name as "companyName",c.timezone,c.currency from employees e join companies c on c.id=e.company_id where e.id=$1 and e.company_id=$2 and e.active=true limit 1`,[a.employeeId,a.companyId]);if(!r.rowCount)return reply.code(401).send({ok:false,error:'EMPLOYEE_AUTH_REQUIRED'});return{ok:true,employee:r.rows[0]}});
app.get('/v1/employee/shifts',async(req,reply)=>{const a=await requireEmployee(req,reply);if(!a)return;const r=await db.query(`select s.id,b.name as "branchName",b.address,s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes",(select ae.occurred_at from attendance_events ae where ae.shift_id=s.id and ae.employee_id=$1 and ae.company_id=$2 and ae.action='CHECK_IN' order by ae.occurred_at asc limit 1) as "checkInAt",(select ae.occurred_at from attendance_events ae where ae.shift_id=s.id and ae.employee_id=$1 and ae.company_id=$2 and ae.action='CHECK_OUT' order by ae.occurred_at desc limit 1) as "checkOutAt" from shifts s join branches b on b.id=s.branch_id and b.company_id=s.company_id where s.company_id=$2 and s.employee_id=$1 and s.ends_at>=now()-interval '1 day' and s.starts_at<now()+interval '30 days' order by s.starts_at asc`,[a.employeeId,a.companyId]);return{ok:true,shifts:r.rows}});


app.post('/v1/employee/logout',async(req)=>{const token=String(req.headers.authorization||'').startsWith('Bearer ')?String(req.headers.authorization).slice(7):'';if(/^[A-Za-z0-9_-]{43}$/.test(token))await db.query('delete from employee_sessions where token_hash=$1',[hash(token)]);return{ok:true}});
}
