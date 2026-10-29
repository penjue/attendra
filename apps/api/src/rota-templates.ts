import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requireAdmin } from './admin-auth.js';

const date = z.iso.date();
const input = z.object({
 branchId:z.uuid(), periodType:z.enum(['WEEKLY','MONTHLY']), anchorStartDate:date,
 shifts:z.array(z.object({employeeId:z.uuid(),dayOffset:z.number().int().min(0).max(30),
 startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
 endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
 endDayOffset:z.number().int().min(0).max(1).default(0),
 breakMinutes:z.number().int().min(0).max(720).default(0)})).min(1).max(500)
}).superRefine((p,ctx)=>{
 const day=new Date(p.anchorStartDate+'T00:00:00Z');
 if(p.periodType==='WEEKLY' && day.getUTCDay()!==1)ctx.addIssue({code:'custom',message:'Weekly rota must begin on Monday'});
 if(p.periodType==='MONTHLY' && day.getUTCDate()!==1)ctx.addIssue({code:'custom',message:'Monthly rota must begin on the first'});
 const monthDays=new Date(day.getUTCFullYear(),day.getUTCMonth()+1,0).getDate();
 for(const [i,s] of p.shifts.entries()){
  if(s.dayOffset >= (p.periodType==='WEEKLY'?7:monthDays))ctx.addIssue({code:'custom',path:['shifts',i,'dayOffset'],message:'Day outside rota period'});
  const duration=((Number(s.endTime.slice(0,2))*60+Number(s.endTime.slice(3)))-(Number(s.startTime.slice(0,2))*60+Number(s.startTime.slice(3)))+s.endDayOffset*1440);
  if(duration<=s.breakMinutes||duration>1440)ctx.addIssue({code:'custom',path:['shifts',i],message:'Invalid shift duration'});
 }
});
const recurrenceInput=z.object({endMode:z.enum(['UNTIL_STOPPED','ON_DATE']),endDate:date.optional()}).refine(p=>p.endMode==='ON_DATE'?!!p.endDate:!p.endDate,{message:'End date must match end mode'});
export function registerRotaTemplateRoutes(app:FastifyInstance,db:Pick<Pool,'connect'|'query'>){
 app.post('/v1/admin/rota-templates',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const parsed=input.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({ok:false,error:'INVALID_ROTA',details:parsed.error.issues});
  const p=parsed.data,c=await db.connect();
  try{
   await c.query('BEGIN');
   const branch=await c.query('select timezone from branches where company_id=$1 and id=$2 and active=true',[a.companyId,p.branchId]);
   if(!branch.rowCount){await c.query('ROLLBACK');return reply.code(404).send({ok:false,error:'BRANCH_NOT_FOUND'})}
   const employees=[...new Set(p.shifts.map(s=>s.employeeId))];
   const eligible=await c.query('select id from employees where company_id=$1 and active=true and id=ANY($2::uuid[])',[a.companyId,employees]);
   if(eligible.rowCount!==employees.length){await c.query('ROLLBACK');return reply.code(400).send({ok:false,error:'EMPLOYEE_NOT_FOUND'})}
   const profile=await c.query('select employee_id,allowed_branch_ids from employee_schedule_profiles where company_id=$1 and employee_id=ANY($2::uuid[])',[a.companyId,employees]);
   if(profile.rows.some(r=>r.allowed_branch_ids?.length&&!r.allowed_branch_ids.includes(p.branchId))){await c.query('ROLLBACK');return reply.code(409).send({ok:false,error:'BRANCH_NOT_ALLOWED'})}
   const t=await c.query(`insert into rota_templates(company_id,branch_id,period_type,anchor_start_date,timezone,created_by)
   values($1,$2,$3,$4,$5,$6) returning id,status`,[a.companyId,p.branchId,p.periodType,p.anchorStartDate,branch.rows[0].timezone,a.adminId??null]);
   for(const s of p.shifts)await c.query(`insert into rota_template_shifts(template_id,employee_id,day_offset,start_local_time,end_local_time,end_day_offset,break_minutes)
   values($1,$2,$3,$4,$5,$6,$7)`,[t.rows[0].id,s.employeeId,s.dayOffset,s.startTime,s.endTime,s.endDayOffset,s.breakMinutes]);
   await c.query('COMMIT');return {ok:true,templateId:t.rows[0].id,status:'DRAFT'};
  }catch(e){await c.query('ROLLBACK');req.log.error(e);return reply.code(500).send({ok:false,error:'ROTA_CREATE_FAILED'})}finally{c.release()}
 });
 app.get('/v1/admin/rota-templates',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const r=await db.query(`select t.id,t.branch_id as "branchId",t.period_type as "periodType",t.anchor_start_date as "anchorStartDate",t.status,t.approved_version as "approvedVersion",
  count(s.id)::int as "shiftCount" from rota_templates t left join rota_template_shifts s on s.template_id=t.id
  where t.company_id=$1 group by t.id order by t.created_at desc limit 100`,[a.companyId]);
  return {ok:true,templates:r.rows};
 });
 app.post('/v1/admin/rota-templates/:templateId/approve',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const id=z.uuid().safeParse((req.params as any).templateId);
  if(!id.success)return reply.code(400).send({ok:false,error:'INVALID_ID'});
  const r=await db.query(`update rota_templates set status='APPROVED',approved_version=approved_version+1,updated_at=now()
   where id=$1 and company_id=$2 and status='DRAFT' returning id,approved_version`,[id.data,a.companyId]);
  return r.rowCount?{ok:true,templateId:id.data,version:r.rows[0].approved_version}:reply.code(409).send({ok:false,error:'TEMPLATE_NOT_APPROVABLE'});
 });
 app.post('/v1/admin/rota-templates/:templateId/recurrence',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const id=z.uuid().safeParse((req.params as any).templateId),p=recurrenceInput.safeParse(req.body);
  if(!id.success||!p.success)return reply.code(400).send({ok:false,error:'INVALID_RECURRENCE'});
  const t=await db.query('select id,period_type,anchor_start_date from rota_templates where id=$1 and company_id=$2 and status=\'APPROVED\'',[id.data,a.companyId]);
  if(!t.rowCount)return reply.code(409).send({ok:false,error:'APPROVED_TEMPLATE_REQUIRED'});
  const base=t.rows[0].anchor_start_date;
  const next=await db.query(`select ($1::date + case when $2='WEEKLY' then interval '7 days' else interval '1 month' end)::date as next`,[base,t.rows[0].period_type]);
  const nextDate=String(next.rows[0].next).slice(0,10);
  if(p.data.endMode==='ON_DATE'&&p.data.endDate!<nextDate)return reply.code(400).send({ok:false,error:'END_DATE_BEFORE_FIRST_REPEAT'});
  const r=await db.query(`insert into rota_recurrences(template_id,cadence,end_mode,end_date,next_period_start,created_by)
  values($1,$2,$3,$4,$5,$6) on conflict do nothing returning id,status`,[id.data,t.rows[0].period_type,p.data.endMode,p.data.endDate??null,nextDate,a.adminId??null]);
  if(!r.rowCount)return reply.code(409).send({ok:false,error:'RECURRENCE_ALREADY_ACTIVE'});
  return {ok:true,recurrenceId:r.rows[0].id,status:r.rows[0].status};
 });
 app.get('/v1/admin/rota-recurrences',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const result=await db.query(`select r.id,r.template_id as "templateId",r.cadence,r.end_mode as "endMode",
   r.end_date::text as "endDate",r.status,r.next_period_start::text as "nextPeriodStart",
   t.branch_id as "branchId",t.period_type as "periodType",t.approved_version as "approvedVersion",
   (select count(*)::int from rota_occurrences o where o.recurrence_id=r.id) as "occurrenceCount"
   from rota_recurrences r join rota_templates t on t.id=r.template_id
   where t.company_id=$1 order by r.created_at desc limit 100`,[a.companyId]);
  return {ok:true,recurrences:result.rows};
 });
 app.get('/v1/admin/rota-recurrences/:recurrenceId/occurrences',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const parsed=z.uuid().safeParse((req.params as {recurrenceId:string}).recurrenceId);
  if(!parsed.success)return reply.code(400).send({ok:false,error:'INVALID_ID'});
  const result=await db.query(`select o.id,o.period_start::text as "periodStart",
   o.template_version as "templateVersion",o.status,o.created_at as "createdAt"
   from rota_occurrences o join rota_recurrences r on r.id=o.recurrence_id
   join rota_templates t on t.id=r.template_id
   where o.recurrence_id=$1 and t.company_id=$2
   order by o.period_start desc limit 100`,[parsed.data,a.companyId]);
  return {ok:true,occurrences:result.rows};
 });
 app.post('/v1/admin/rota-recurrences/:recurrenceId/status',async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  const id=z.uuid().safeParse((req.params as any).recurrenceId),p=z.object({status:z.enum(['ACTIVE','PAUSED','STOPPED'])}).safeParse(req.body);
  if(!id.success||!p.success)return reply.code(400).send({ok:false,error:'INVALID_STATUS'});
  const r=await db.query(`update rota_recurrences r set status=$3,updated_at=now() from rota_templates t
  where r.id=$1 and r.template_id=t.id and t.company_id=$2 and r.status<>'STOPPED' returning r.id`,[id.data,a.companyId,p.data.status]);
  return r.rowCount?{ok:true,status:p.data.status}:reply.code(404).send({ok:false,error:'RECURRENCE_NOT_FOUND_OR_STOPPED'});
 });
}
