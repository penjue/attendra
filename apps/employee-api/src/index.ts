import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';

const app=Fastify({logger:true});
await app.register(cors,{origin:true});
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined});
const secret=()=>process.env.EMPLOYEE_TOKEN_SECRET||process.env.JWT_SECRET||'';
type EmployeeToken={kind:'EMPLOYEE';companyId:string;employeeId:string;employeeNumber:string;exp:number};
const sign=(p:EmployeeToken)=>{const b=Buffer.from(JSON.stringify(p)).toString('base64url');const s=createHmac('sha256',secret()).update(b).digest('base64url');return `${b}.${s}`};
const verify=(token:string):EmployeeToken|null=>{if(!secret())return null;const [b,s]=token.split('.');if(!b||!s)return null;const e=createHmac('sha256',secret()).update(b).digest('base64url');const a=Buffer.from(s),c=Buffer.from(e);if(a.length!==c.length||!timingSafeEqual(a,c))return null;try{const p=JSON.parse(Buffer.from(b,'base64url').toString()) as EmployeeToken;return p.kind==='EMPLOYEE'&&p.exp>Date.now()?p:null}catch{return null}};
const requireEmployee=(req:any,reply:any)=>{const h=String(req.headers.authorization||'');const p=verify(h.startsWith('Bearer ')?h.slice(7):'');if(!p){reply.code(401).send({ok:false,error:'EMPLOYEE_AUTH_REQUIRED'});return null}return p};

app.get('/health',async()=>({ok:true,service:'attendra-employee-api',time:new Date().toISOString()}));
app.post('/v1/employee/login',async(req,reply)=>{const p=z.object({companyId:z.uuid(),employeeNumber:z.string().trim().min(1).max(64),pin:z.string().regex(/^\d{4,12}$/)}).safeParse(req.body);if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_LOGIN_REQUEST'});const r=await db.query(`select e.id,e.employee_number as "employeeNumber",e.first_name as "firstName",e.last_name as "lastName",c.name as "companyName" from employees e join companies c on c.id=e.company_id where e.company_id=$1 and e.employee_number=$2 and e.active=true and e.pin_hash=crypt($3,e.pin_hash) limit 1`,[p.data.companyId,p.data.employeeNumber,p.data.pin]);if(!r.rowCount)return reply.code(401).send({ok:false,error:'INVALID_EMPLOYEE_OR_PIN'});const e=r.rows[0],exp=Date.now()+12*60*60*1000;return{ok:true,token:sign({kind:'EMPLOYEE',companyId:p.data.companyId,employeeId:e.id,employeeNumber:e.employeeNumber,exp}),expiresAt:exp,employee:e}});
app.get('/v1/employee/me',async(req,reply)=>{const a=requireEmployee(req,reply);if(!a)return;const r=await db.query(`select e.id,e.employee_number as "employeeNumber",e.first_name as "firstName",e.last_name as "lastName",c.name as "companyName",c.timezone,c.currency from employees e join companies c on c.id=e.company_id where e.id=$1 and e.company_id=$2 and e.active=true limit 1`,[a.employeeId,a.companyId]);if(!r.rowCount)return reply.code(404).send({ok:false,error:'EMPLOYEE_NOT_FOUND'});return{ok:true,employee:r.rows[0]}});
app.get('/v1/employee/shifts',async(req,reply)=>{const a=requireEmployee(req,reply);if(!a)return;const r=await db.query(`select s.id,b.name as "branchName",b.address,s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes",(select ae.occurred_at from attendance_events ae where ae.shift_id=s.id and ae.employee_id=$1 and ae.action='CHECK_IN' order by ae.occurred_at asc limit 1) as "checkInAt",(select ae.occurred_at from attendance_events ae where ae.shift_id=s.id and ae.employee_id=$1 and ae.action='CHECK_OUT' order by ae.occurred_at desc limit 1) as "checkOutAt" from shifts s join branches b on b.id=s.branch_id where s.company_id=$2 and s.employee_id=$1 and s.ends_at>=now()-interval '1 day' and s.starts_at<now()+interval '30 days' order by s.starts_at asc`,[a.employeeId,a.companyId]);return{ok:true,shifts:r.rows}});

const port=Number(process.env.PORT||4100);await app.listen({port,host:'0.0.0.0'});
