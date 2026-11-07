import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { requireAdmin, type AdminToken } from './admin-auth.js';
import { authenticateEmployee } from './employee-routes.js';
import { eligibleCover, netShiftHours, validDateRange } from './scheduling-rules.js';
const rangeSchema=z.object({from:z.iso.date(),to:z.iso.date()}).refine(v=>validDateRange(v.from,v.to),'Select at most 62 days');
const times={startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),breakMinutes:z.number().int().min(0).max(720).optional().transform(()=>0)};
const validTimes=(p:{startTime:string;endTime:string;breakMinutes:number})=>{const minutes=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3));const duration=(minutes(p.endTime)-minutes(p.startTime)+1440)%1440;return duration>p.breakMinutes};
const ids=z.array(z.uuid()).min(1).max(500);
class ScheduleError extends Error { constructor(public code:string,public status=409){super(code)} }
const id=(req:FastifyRequest,key:string)=>z.uuid().parse((req.params as Record<string,string>)[key]);
const shiftColumns=`s.id,s.employee_id as "employeeId",s.branch_id as "branchId",s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes",s.published,concat(e.first_name,' ',e.last_name) as "employeeName",e.employee_number as "employeeNumber",b.name as "branchName",b.timezone,
 exists(select 1 from employee_unavailability u where u.company_id=s.company_id and u.employee_id=s.employee_id and u.active=true and u.starts_at<s.ends_at and (u.ends_at is null or u.ends_at>s.starts_at)) or exists(select 1 from employee_day_off_rules dor join companies dc on dc.id=dor.company_id where dor.company_id=s.company_id and dor.employee_id=s.employee_id and dor.active=true and exists(select 1 from generate_series((s.starts_at at time zone dc.timezone)::date,((s.ends_at - interval '1 microsecond') at time zone dc.timezone)::date,interval '1 day') as offday(day) where offday.day::date>=dor.starts_on and (dor.ends_on is null or offday.day::date<=dor.ends_on) and ((dor.frequency='WEEKLY' and extract(isodow from offday.day)::int=any(dor.weekdays)) or (dor.frequency='MONTHLY' and extract(day from offday.day)::int=any(dor.month_days))))) as "needsCover",
 exists(select 1 from attendance_events ae where ae.shift_id=s.id) as "hasAttendance"`;
export function registerSchedulingRoutes(app:FastifyInstance,db:Pick<Pool,'query'|'connect'>){
 const tx=async<T>(work:(c:PoolClient)=>Promise<T>)=>{const c=await db.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}};
 const route=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,handler:(req:FastifyRequest,a:AdminToken)=>Promise<any>)=>app.route({method,url,handler:async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;reply.header('Cache-Control','no-store');
  try{return await handler(req,a)}catch(error:any){if(error instanceof z.ZodError)return reply.code(400).send({ok:false,error:'INVALID_SCHEDULE_REQUEST',message:error.issues[0]?.message});
   if(error.code==='40P01')return reply.code(409).send({ok:false,error:'SCHEDULE_CHANGED_RETRY'});
   if(error instanceof ScheduleError||error.code==='P0001')return reply.code(error.status||409).send({ok:false,error:error instanceof ScheduleError?error.code:error.message});app.log.error(error);return reply.code(500).send({ok:false,error:'SCHEDULE_OPERATION_FAILED'})}
 }});
 const audit=async(c:PoolClient,a:AdminToken,action:string,entity:string,entityId:string)=>c.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id) values($1,'ADMIN',$2,$3,$4,$5)`,[a.companyId,a.adminId||a.email,action,entity,entityId]);
 const notice=async(c:PoolClient,company:string,employee:string,message:string)=>c.query('insert into schedule_notices(company_id,employee_id,message) values($1,$2,$3)',[company,employee,message]);
 const lockEmployees=async(c:PoolClient,company:string,employeeIds:string[])=>{const r=await c.query('select id from employees where company_id=$1 and id=ANY($2::uuid[]) and active=true order by id for update',[company,[...new Set(employeeIds)]]);if(r.rowCount!==new Set(employeeIds).size)throw new ScheduleError('EMPLOYEE_NOT_FOUND',404)};
 const checkAssignment=async(c:PoolClient,company:string,employee:string,branch:string,start:Date,end:Date,exclude:string|null=null)=>{
  const conflict=await c.query(`select 1 from shifts where company_id=$1 and employee_id=$2 and starts_at<$4 and ends_at>$3 and ($5::uuid is null or id<>$5) limit 1`,[company,employee,start,end,exclude]);if(conflict.rowCount)return 'SHIFT_OVERLAP';
  const absent=await c.query('select 1 from employee_unavailability where company_id=$1 and employee_id=$2 and active=true and starts_at<$4 and (ends_at is null or ends_at>$3) limit 1',[company,employee,start,end]);if(absent.rowCount)return 'EMPLOYEE_UNAVAILABLE';
  const recurring=await c.query(`select 1 from employee_day_off_rules dor join companies co on co.id=dor.company_id cross join lateral generate_series(($3::timestamptz at time zone co.timezone)::date,(($4::timestamptz-interval '1 microsecond') at time zone co.timezone)::date,interval '1 day') dayoff(day) where dor.company_id=$1 and dor.employee_id=$2 and dor.active=true and dayoff.day::date>=dor.starts_on and (dor.ends_on is null or dayoff.day::date<=dor.ends_on) and ((dor.frequency='WEEKLY' and extract(isodow from dayoff.day)::int=any(dor.weekdays)) or (dor.frequency='MONTHLY' and extract(day from dayoff.day)::int=any(dor.month_days))) limit 1`,[company,employee,start,end]);if(recurring.rowCount)return 'EMPLOYEE_UNAVAILABLE';
  const profile=await c.query('select allowed_branch_ids from employee_schedule_profiles where company_id=$1 and employee_id=$2',[company,employee]);const allowed=profile.rows[0]?.allowed_branch_ids||[];if(allowed.length&&!allowed.includes(branch))return 'BRANCH_NOT_ALLOWED';return '';
 };
 const checkHours=async(c:PoolClient,company:string,employee:string,start:Date,hours:number)=>{const r=await c.query(`select coalesce(p.max_weekly_hours,40)::float as "limit",coalesce((select sum(greatest(0,extract(epoch from(x.ends_at-x.starts_at))/3600)) from shifts x where x.company_id=$1 and x.employee_id=$2 and x.starts_at>=date_trunc('week',$3::timestamptz at time zone co.timezone) at time zone co.timezone and x.starts_at<(date_trunc('week',$3::timestamptz at time zone co.timezone)+interval '7 days') at time zone co.timezone),0)::float as hours from companies co left join employee_schedule_profiles p on p.company_id=co.id and p.employee_id=$2 where co.id=$1`,[company,employee,start]);return Number(r.rows[0].hours)+hours>Number(r.rows[0].limit)?'WEEKLY_HOURS_EXCEEDED':''};
 route('POST','/v1/admin/scheduling/drafts',async(req,a)=>{const p=z.object({employeeIds:ids,branchId:z.uuid(),date:z.iso.date(),...times}).refine(validTimes,'Break must be shorter than the shift; start and end must differ').parse(req.body);return tx(async c=>{await lockEmployees(c,a.companyId,p.employeeIds);const b=await c.query(`select ($3::date+$4::time) at time zone timezone as start,($3::date+case when $5::time<=$4::time then 1 else 0 end+$5::time) at time zone timezone as "end" from branches where id=$1 and company_id=$2 and active=true`,[p.branchId,a.companyId,p.date,p.startTime,p.endTime]);if(!b.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);const start=new Date(b.rows[0].start),end=new Date(b.rows[0].end);if(start.getTime()<Date.now())throw new ScheduleError('SHIFT_IN_PAST');for(const employee of [...new Set(p.employeeIds)]){const conflict=await checkAssignment(c,a.companyId,employee,p.branchId,start,end);if(conflict)throw new ScheduleError(conflict);const hours=await checkHours(c,a.companyId,employee,start,netShiftHours(start,end,p.breakMinutes));if(hours&&hours!=='WEEKLY_HOURS_EXCEEDED')throw new ScheduleError(hours);await c.query('insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,break_minutes,published) values($1,$2,$3,$4,$5,$6,false)',[a.companyId,employee,p.branchId,start,end,p.breakMinutes])}await audit(c,a,'CREATE_DRAFT_SHIFTS','BRANCH',p.branchId);return{ok:true,created:new Set(p.employeeIds).size}})});
 route('GET','/v1/admin/scheduling/meta',async(_req,a)=>{
  const [employees,branches,company]=await Promise.all([db.query(`select e.id,concat(e.first_name,' ',e.last_name) as name,e.employee_number as "employeeNumber",coalesce(p.job_role,'') as "jobRole",coalesce(p.max_weekly_hours,40) as "maxWeeklyHours",coalesce(p.allowed_branch_ids,'{}'::uuid[]) as "allowedBranchIds" from employees e left join employee_schedule_profiles p on p.employee_id=e.id and p.company_id=e.company_id where e.company_id=$1 and e.active=true order by e.first_name,e.last_name`,[a.companyId]),db.query('select id,name,timezone from branches where company_id=$1 and active=true order by name',[a.companyId]),db.query('select timezone from companies where id=$1',[a.companyId])]);return{ok:true,employees:employees.rows,branches:branches.rows,timezone:company.rows[0].timezone};
 });
 route('PUT','/v1/admin/scheduling/profiles/:employeeId',async(req,a)=>{
  const employee=id(req,'employeeId'),p=z.object({jobRole:z.string().trim().max(100),maxWeeklyHours:z.number().min(1).max(168),allowedBranchIds:z.array(z.uuid()).max(100).default([])}).parse(req.body);
  return tx(async c=>{await lockEmployees(c,a.companyId,[employee]);if(p.allowedBranchIds.length){const branches=await c.query('select id from branches where company_id=$1 and active=true and id=ANY($2::uuid[])',[a.companyId,[...new Set(p.allowedBranchIds)]]);if(branches.rowCount!==new Set(p.allowedBranchIds).size)throw new ScheduleError('BRANCH_NOT_FOUND',404)}await c.query(`insert into employee_schedule_profiles(employee_id,company_id,job_role,max_weekly_hours,allowed_branch_ids) values($1,$2,$3,$4,$5) on conflict(employee_id) do update set job_role=excluded.job_role,max_weekly_hours=excluded.max_weekly_hours,allowed_branch_ids=excluded.allowed_branch_ids`,[employee,a.companyId,p.jobRole,p.maxWeeklyHours,p.allowedBranchIds]);await audit(c,a,'UPDATE_SCHEDULE_PROFILE','EMPLOYEE',employee);return{ok:true}});
 });
 route('GET','/v1/admin/scheduling/weekly-hours-overages',async(_req,a)=>{const r=await db.query(`with week_segments as (
 select s.employee_id,co.timezone,coalesce(p.max_weekly_hours,40)::numeric as weekly_limit,
 greatest(s.starts_at, w.week_start at time zone co.timezone) as segment_start,
 least(s.ends_at, (w.week_start+interval '7 days') at time zone co.timezone) as segment_end,
 w.week_start::date as week_start,
 s.break_minutes,
 extract(epoch from(s.ends_at-s.starts_at))/60 as shift_minutes
 from shifts s join companies co on co.id=s.company_id
 left join employee_schedule_profiles p on p.employee_id=s.employee_id and p.company_id=s.company_id
 cross join lateral generate_series(
 date_trunc('week',s.starts_at at time zone co.timezone),
 date_trunc('week',(s.ends_at-interval '1 microsecond') at time zone co.timezone),
 interval '7 days') as w(week_start)
 where s.company_id=$1
), weekly as (
 select employee_id,week_start,weekly_limit,
 sum(greatest(0,extract(epoch from(segment_end-segment_start))/3600)
 * case when shift_minutes>0 then greatest(0,1-break_minutes/shift_minutes) else 0 end)::numeric as assigned_hours
 from week_segments group by employee_id,week_start,weekly_limit
) select employee_id as "employeeId",week_start as "weekStart",
 round(assigned_hours,2)::float as "assignedHours",weekly_limit::float as "weeklyLimit",
 round(greatest(assigned_hours-weekly_limit,0),2)::float as "potentialOvertimeHours",
 round(greatest(greatest(assigned_hours-weekly_limit,0)-coalesce(approved.approved_hours,0),0),2)::float as "unapprovedPotentialOvertimeHours",
 round(coalesce(approved.approved_hours,0),2)::float as "approvedOvertimeHours"
 from weekly left join lateral (
   select sum(oa.overtime_hours)::numeric as approved_hours
   from shift_overtime_approvals oa join shifts approved_shift on approved_shift.id=oa.shift_id
   where oa.company_id=$1 and oa.employee_id=weekly.employee_id and oa.week_start=weekly.week_start and approved_shift.published=true
 ) approved on true
 where assigned_hours>weekly_limit order by week_start desc,employee_id`,[a.companyId]);
 return{ok:true,overages:r.rows,notice:'Potential overtime only. No manager approval or payroll entitlement is implied.'}});
 route('GET','/v1/admin/scheduling/compensation-profiles',async(_req,a)=>{
  const r=await db.query(`select e.id as "employeeId",e.employee_number as "employeeNumber",concat(e.first_name,' ',e.last_name) as "employeeName",e.hourly_worker as "hourlyWorker",
   cp.pay_type as "payType",cp.hourly_rate::float as "hourlyRate",cp.monthly_salary::float as "monthlySalary",co.currency,cp.updated_at as "updatedAt"
   from employees e join companies co on co.id=e.company_id
   left join employee_compensation_profiles cp on cp.company_id=e.company_id and cp.employee_id=e.id
   where e.company_id=$1 order by e.first_name,e.last_name`,[a.companyId]);
  return{ok:true,profiles:r.rows};
 });
 route('PUT','/v1/admin/scheduling/compensation-profiles/:employeeId',async(req,a)=>{
  const employeeId=id(req,'employeeId');
  const p=z.discriminatedUnion('payType',[
   z.object({payType:z.literal('HOURLY'),hourlyRate:z.number().finite().min(0).max(1000000)}).strict(),
   z.object({payType:z.literal('MONTHLY'),monthlySalary:z.number().finite().min(0).max(100000000)}).strict()
  ]).parse(req.body);
  return tx(async c=>{
   const employee=await c.query('select id from employees where company_id=$1 and id=$2 for update',[a.companyId,employeeId]);
   if(!employee.rowCount)throw new ScheduleError('EMPLOYEE_NOT_FOUND',404);
   const locked=await c.query(`select 1 from employee_payroll_snapshots where company_id=$1 and employee_id=$2 and status='FINALISED' limit 1`,[a.companyId,employeeId]);
   if(locked.rowCount)throw new ScheduleError('COMPENSATION_CHANGE_REQUIRES_EFFECTIVE_DATE',409);
   const rate=p.payType==='HOURLY'?p.hourlyRate:null,salary=p.payType==='MONTHLY'?p.monthlySalary:null;
   const r=await c.query(`insert into employee_compensation_profiles(company_id,employee_id,pay_type,hourly_rate,monthly_salary,currency)
    select $1,$2,$3,$4,$5,co.currency from companies co where co.id=$1
    on conflict(company_id,employee_id) do update set pay_type=excluded.pay_type,hourly_rate=excluded.hourly_rate,monthly_salary=excluded.monthly_salary,currency=excluded.currency,updated_at=now()
    returning employee_id as "employeeId",pay_type as "payType",hourly_rate::float as "hourlyRate",monthly_salary::float as "monthlySalary",currency`,
    [a.companyId,employeeId,p.payType,rate,salary]);
   await c.query('update employees set hourly_worker=$3 where company_id=$1 and id=$2',[a.companyId,employeeId,p.payType==='HOURLY']);
   await audit(c,a,'UPDATE_COMPENSATION_PROFILE','EMPLOYEE',employeeId);
   return{ok:true,profile:r.rows[0],notice:'Compensation profile saved. No payroll has been calculated or finalised.'};
  });
 });
 route('GET','/v1/admin/scheduling/payroll-shift-reviews',async(req,a)=>{
  const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).parse(req.query);
  const r=await db.query(`select s.id as "shiftId",s.employee_id as "employeeId",concat(e.first_name,' ',e.last_name) as "employeeName",b.name as "branchName",s.starts_at as "startsAt",s.ends_at as "endsAt",s.published,
   exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_IN') as "hasCheckIn",
   exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_OUT') as "hasCheckOut",
   pr.decision,pr.note,pr.reviewed_at as "reviewedAt"
   from shifts s join companies co on co.id=s.company_id join employees e on e.id=s.employee_id
   join branches b on b.id=s.branch_id left join payroll_shift_reviews pr on pr.company_id=s.company_id and pr.shift_id=s.id
   where s.company_id=$1 and s.published=true
   and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
   and to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2
   and s.ends_at<=now()
   and (pr.decision is not null or not exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_IN')
    or not exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_OUT'))
   order by s.starts_at desc limit 500`,[a.companyId,p.month]);
  return{ok:true,month:p.month,reviews:r.rows,notice:'Review decisions are recorded but do not yet change provisional gross payroll. Missing attendance alone does not automatically deduct assigned pay. Cross-month shifts are not included.'};
 });
 route('PUT','/v1/admin/scheduling/payroll-shift-reviews/:shiftId',async(req,a)=>{
  const shiftId=id(req,'shiftId');
  const p=z.object({decision:z.enum(['WORKED','CANCELLED','REASSIGNMENT_REQUIRED']),note:z.string().trim().max(1000).default('')}).strict().parse(req.body);
  if(p.decision==='REASSIGNMENT_REQUIRED'&&!p.note)throw new ScheduleError('REASSIGNMENT_NOTE_REQUIRED',400);
  return tx(async c=>{
   const r=await c.query(`select s.employee_id from shifts s join companies co on co.id=s.company_id where s.company_id=$1 and s.id=$2 and s.published=true and s.ends_at<=now() for update of s`,[a.companyId,shiftId]);
   if(!r.rowCount)throw new ScheduleError('COMPLETED_PUBLISHED_SHIFT_NOT_FOUND',404);
   const locked=await c.query(`select 1 from employee_payroll_snapshots where company_id=$1 and employee_id=$2 and status='FINALISED' limit 1`,[a.companyId,r.rows[0].employee_id]);
   if(locked.rowCount)throw new ScheduleError('FINALISED_PAYROLL_REVIEW_LOCKED',409);
   const review=await c.query(`insert into payroll_shift_reviews(company_id,shift_id,employee_id,decision,note,reviewed_by)
    values($1,$2,$3,$4,$5,$6) on conflict(company_id,shift_id) do update set decision=excluded.decision,note=excluded.note,reviewed_by=excluded.reviewed_by,reviewed_at=now()
    returning shift_id as "shiftId",decision,note,reviewed_at as "reviewedAt"`,[a.companyId,shiftId,r.rows[0].employee_id,p.decision,p.note,a.adminId||null]);
   await audit(c,a,'REVIEW_PAYROLL_SHIFT','SHIFT',shiftId);
   return{ok:true,review:review.rows[0],notice:'Decision recorded for reconciliation; payroll amounts have not been changed.'};
  });
 });
 route('GET','/v1/admin/scheduling/payroll-readiness',async(req,a)=>{
  const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).parse(req.query);
  const q=await db.query(`with relevant as (
    select s.id,s.employee_id,s.published,s.starts_at,s.ends_at,
      to_char(s.starts_at at time zone co.timezone,'YYYY-MM') as start_month,
      to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM') as end_month
    from shifts s join companies co on co.id=s.company_id
    where s.company_id=$1 and (to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
      or to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2)
   ) select
    count(*) filter(where not published)::int as "unpublishedShifts",
    count(*) filter(where published and ends_at>now())::int as "unfinishedShifts",
    count(*) filter(where start_month<>end_month)::int as "crossMonthShifts",
    count(*) filter(where published and ends_at<=now() and start_month=end_month
      and not exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=relevant.id)
      and (not exists(select 1 from attendance_events ae where ae.shift_id=relevant.id and ae.employee_id=relevant.employee_id and ae.action='CHECK_IN')
        or not exists(select 1 from attendance_events ae where ae.shift_id=relevant.id and ae.employee_id=relevant.employee_id and ae.action='CHECK_OUT')))::int as "unreviewedAttendanceExceptions",
    count(*) filter(where exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=relevant.id and pr.decision='REASSIGNMENT_REQUIRED'))::int as "pendingReassignments"
   from relevant`,[a.companyId,p.month]);
  const profiles=await db.query(`select count(*)::int as count from employees e where e.company_id=$1 and e.active=true
    and not exists(select 1 from employee_compensation_profiles cp where cp.company_id=e.company_id and cp.employee_id=e.id)`,[a.companyId]);
  const finalised=await db.query(`select count(*)::int as count from employee_payroll_snapshots where company_id=$1 and payroll_month=($2||'-01')::date and status='FINALISED'`,[a.companyId,p.month]);
  const company=await db.query(`select (date_trunc('month',now() at time zone timezone) > ($2||'-01')::date) as closed from companies where id=$1`,[a.companyId,p.month]);
  const blockers={...q.rows[0],payrollMonthStillOpen:!company.rows[0]?.closed,missingCompensationProfiles:Number(profiles.rows[0].count),alreadyFinalisedEmployees:Number(finalised.rows[0].count)};
  return{ok:true,month:p.month,ready:false,blockers,notice:'Advisory readiness check only. Final payroll approval is disabled. An open payroll month and unfinished shifts must not be treated as ready; exception reconciliation, cross-month allocation, pay-rate history and other controls remain incomplete.'};
 });
 route('POST','/v1/admin/scheduling/payroll-approval-preflight',async(req,a)=>{
  const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).strict().parse(req.body);
  const result=await db.query(`select coalesce(bool_or(now() at time zone co.timezone < (($2||'-01')::date+interval '1 month')),false) as "monthOpen",
   count(s.id) filter(where s.id is not null and (s.published=false or s.ends_at>now()))::int as "unreadyShifts",
   count(s.id) filter(where s.id is not null and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')<>to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM'))::int as "crossMonthShifts",
   count(s.id) filter(where s.id is not null and exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=s.id and pr.decision='REASSIGNMENT_REQUIRED'))::int as "pendingReassignments",
   count(s.id) filter(where s.id is not null and s.published and s.ends_at<=now()
    and not exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=s.id)
    and (not exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_IN')
     or not exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_OUT')))::int as "unreviewedAttendanceExceptions"
   from companies co left join shifts s on s.company_id=co.id
    and (to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2 or to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2)
   where co.id=$1`,[a.companyId,p.month]);
  const profiles=await db.query(`select count(*)::int as count from employees e where e.company_id=$1 and e.active
   and not exists(select 1 from employee_compensation_profiles cp where cp.company_id=e.company_id and cp.employee_id=e.id)`,[a.companyId]);
  const finalised=await db.query(`select count(*)::int as count from employee_payroll_snapshots where company_id=$1 and payroll_month=($2||'-01')::date and status='FINALISED'`,[a.companyId,p.month]);
  const overtime=await db.query(`with week_segments as (
    select s.employee_id,coalesce(sp.max_weekly_hours,40)::numeric as weekly_limit,
     w.week_start::date as week_start,
     greatest(s.starts_at,w.week_start at time zone co.timezone) as segment_start,
     least(s.ends_at,(w.week_start+interval '7 days') at time zone co.timezone) as segment_end,
     s.break_minutes,extract(epoch from(s.ends_at-s.starts_at))/60 as shift_minutes
    from shifts s join companies co on co.id=s.company_id
    left join employee_schedule_profiles sp on sp.company_id=s.company_id and sp.employee_id=s.employee_id
    cross join lateral generate_series(date_trunc('week',s.starts_at at time zone co.timezone),
      date_trunc('week',(s.ends_at-interval '1 microsecond') at time zone co.timezone),interval '7 days') as w(week_start)
    where s.company_id=$1 and s.published=true
      and to_char(w.week_start,'YYYY-MM')=$2
   ),weekly as (
    select employee_id,week_start,weekly_limit,
     sum(greatest(0,extract(epoch from(segment_end-segment_start))/3600)
       *case when shift_minutes>0 then greatest(0,1-break_minutes/shift_minutes) else 0 end)::numeric as assigned_hours
    from week_segments group by employee_id,week_start,weekly_limit
   ) select count(*)::int as count from weekly w where w.assigned_hours>w.weekly_limit
     and w.assigned_hours-w.weekly_limit>coalesce((select sum(oa.overtime_hours) from shift_overtime_approvals oa
       join shifts os on os.id=oa.shift_id and os.company_id=oa.company_id
       where oa.company_id=$1 and oa.employee_id=w.employee_id and oa.week_start=w.week_start and os.published=true),0)+0.01`,[a.companyId,p.month]);
  const blockers={...result.rows[0],missingCompensationProfiles:Number(profiles.rows[0].count),alreadyFinalisedEmployees:Number(finalised.rows[0].count),potentialUnapprovedOvertimeWeeks:Number(overtime.rows[0].count)};
  return{ok:true,month:p.month,approvalAllowed:false,blockers,notice:'Preflight only: no payroll records were written. Final approval remains disabled pending full reconciliation, rate history and payslip controls.'};
 });
 route('GET','/v1/admin/scheduling/payroll-adjustment-reconciliation',async(req,a)=>{
  const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).parse(req.query);
  const r=await db.query(`select d.employee_id as "employeeId",d.currency,
   round(coalesce(sum(d.amount) filter(where d.kind='BONUS'),0),2)::float as "approvedBonuses",
   round(coalesce(sum(d.amount) filter(where d.kind='DEDUCTION'),0),2)::float as "approvedDeductions",
   count(*)::int as "approvedCount"
   from payroll_draft_adjustments d
   where d.company_id=$1 and d.payroll_month=($2||'-01')::date
    and d.review_status='APPROVED' and d.voided_at is null
   group by d.employee_id,d.currency`,[a.companyId,p.month]);
  return{ok:true,month:p.month,adjustments:r.rows,notice:'Read-only approved adjustment totals. Not posted to payroll snapshots or payslips. Review blockers before finalisation.'};
 });
 route('GET','/v1/admin/scheduling/payroll-draft-adjustments',async(req,a)=>{
  const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).parse(req.query);
  const r=await db.query(`select d.id,d.employee_id as "employeeId",concat(e.first_name,' ',e.last_name) as "employeeName",d.kind,d.amount::float as amount,d.currency,d.reason,d.created_at as "createdAt",d.voided_at as "voidedAt",d.review_status as "reviewStatus",d.reviewed_at as "reviewedAt",d.review_note as "reviewNote"
    from payroll_draft_adjustments d join employees e on e.id=d.employee_id and e.company_id=d.company_id
    where d.company_id=$1 and d.payroll_month=($2||'-01')::date order by d.created_at desc`,[a.companyId,p.month]);
  return{ok:true,month:p.month,adjustments:r.rows,notice:'Draft entries only. They are excluded from gross payroll and payslips.'};
 });
 route('POST','/v1/admin/scheduling/payroll-draft-adjustments',async(req,a)=>{
  const p=z.object({employeeId:z.uuid(),month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),kind:z.enum(['BONUS','DEDUCTION']),amount:z.number().finite().positive().max(100000000),reason:z.string().trim().min(5).max(1000)}).strict().parse(req.body);
  if(Math.round(p.amount*100)!==p.amount*100&&Math.abs(Math.round(p.amount*100)-p.amount*100)>0.000001)throw new ScheduleError('ADJUSTMENT_REQUIRES_TWO_DECIMALS',400);
  return tx(async c=>{
   const e=await c.query(`select cp.currency from employees e join employee_compensation_profiles cp on cp.company_id=e.company_id and cp.employee_id=e.id where e.company_id=$1 and e.id=$2 and e.active=true for update of e`,[a.companyId,p.employeeId]);
   if(!e.rowCount)throw new ScheduleError('ACTIVE_EMPLOYEE_COMPENSATION_NOT_FOUND',404);
   const locked=await c.query(`select 1 from employee_payroll_snapshots where company_id=$1 and employee_id=$2 and payroll_month=($3||'-01')::date and status='FINALISED'`,[a.companyId,p.employeeId,p.month]);
   if(locked.rowCount)throw new ScheduleError('PAYROLL_ALREADY_FINALISED',409);
   const r=await c.query(`insert into payroll_draft_adjustments(company_id,employee_id,payroll_month,kind,amount,currency,reason,created_by) values($1,$2,($3||'-01')::date,$4,$5,$6,$7,$8) returning id`,[a.companyId,p.employeeId,p.month,p.kind,p.amount,e.rows[0].currency,p.reason,String(a.adminId||a.email)]);
   await audit(c,a,'CREATE_DRAFT_PAYROLL_ADJUSTMENT','PAYROLL_ADJUSTMENT',r.rows[0].id);
   return{ok:true,id:r.rows[0].id,notice:'Draft saved for review. No payroll amount has changed.'};
  });
 });
 route('POST','/v1/admin/scheduling/payroll-draft-adjustments/:adjustmentId/review',async(req,a)=>{
  const adjustmentId=id(req,'adjustmentId');
  const p=z.object({decision:z.enum(['APPROVED','REJECTED']),note:z.string().trim().min(5).max(1000)}).strict().parse(req.body);
  return tx(async c=>{
   const r=await c.query(`select employee_id,payroll_month,review_status,voided_at from payroll_draft_adjustments where company_id=$1 and id=$2 for update`,[a.companyId,adjustmentId]);
   if(!r.rowCount)throw new ScheduleError('DRAFT_ADJUSTMENT_NOT_FOUND',404);
   if(r.rows[0].voided_at||r.rows[0].review_status!=='PENDING')throw new ScheduleError('ADJUSTMENT_NOT_PENDING',409);
   const locked=await c.query(`select 1 from employee_payroll_snapshots where company_id=$1 and employee_id=$2 and payroll_month=$3 and status='FINALISED'`,[a.companyId,r.rows[0].employee_id,r.rows[0].payroll_month]);
   if(locked.rowCount)throw new ScheduleError('PAYROLL_ALREADY_FINALISED',409);
   await c.query(`update payroll_draft_adjustments set review_status=$3,reviewed_at=now(),reviewed_by=$4,review_note=$5 where company_id=$1 and id=$2`,[a.companyId,adjustmentId,p.decision,String(a.adminId||a.email),p.note]);
   await audit(c,a,p.decision==='APPROVED'?'APPROVE_DRAFT_PAYROLL_ADJUSTMENT':'REJECT_DRAFT_PAYROLL_ADJUSTMENT','PAYROLL_ADJUSTMENT',adjustmentId);
   return{ok:true,decision:p.decision,notice:'Decision recorded. Approved adjustments are not yet applied to payroll totals or payslips.'};
  });
 });
 route('DELETE','/v1/admin/scheduling/payroll-draft-adjustments/:adjustmentId',async(req,a)=>{
  const adjustmentId=id(req,'adjustmentId');
  return tx(async c=>{
   const r=await c.query(`select d.employee_id,d.payroll_month from payroll_draft_adjustments d where d.company_id=$1 and d.id=$2 and d.voided_at is null for update`,[a.companyId,adjustmentId]);
   if(!r.rowCount)throw new ScheduleError('ACTIVE_DRAFT_ADJUSTMENT_NOT_FOUND',404);
   const status=await c.query('select review_status from payroll_draft_adjustments where company_id=$1 and id=$2',[a.companyId,adjustmentId]);
   if(status.rows[0].review_status!=='PENDING')throw new ScheduleError('REVIEWED_ADJUSTMENT_CANNOT_BE_VOIDED',409);
   const locked=await c.query(`select 1 from employee_payroll_snapshots where company_id=$1 and employee_id=$2 and payroll_month=$3 and status='FINALISED'`,[a.companyId,r.rows[0].employee_id,r.rows[0].payroll_month]);
   if(locked.rowCount)throw new ScheduleError('PAYROLL_ALREADY_FINALISED',409);
   await c.query(`update payroll_draft_adjustments set voided_at=now(),voided_by=$3 where company_id=$1 and id=$2`,[a.companyId,adjustmentId,String(a.adminId||a.email)]);
   await audit(c,a,'VOID_DRAFT_PAYROLL_ADJUSTMENT','PAYROLL_ADJUSTMENT',adjustmentId);
   return{ok:true,notice:'Draft adjustment voided; history retained.'};
  });
 });
 route('GET','/v1/admin/scheduling/payroll-preview',async(req,a)=>{
  const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).parse(req.query);
  const result=await db.query(`with eligible_shifts as (
   select s.id,s.employee_id,s.break_minutes,s.starts_at,s.ends_at,
    greatest(0,extract(epoch from(s.ends_at-s.starts_at))/3600)::numeric as duration_hours,
    cp.pay_type,cp.hourly_rate,cp.monthly_salary,cp.currency
   from shifts s join companies co on co.id=s.company_id
   join employee_compensation_profiles cp on cp.company_id=s.company_id and cp.employee_id=s.employee_id
   where s.company_id=$1 and s.published=true
    and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
    and to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2
    and not exists(select 1 from payroll_shift_reviews pr where pr.company_id=s.company_id and pr.shift_id=s.id and pr.decision='CANCELLED')
  ), approved as (
   select oa.shift_id,sum(oa.overtime_hours) as hours,sum(oa.overtime_hours*oa.approved_hourly_rate) as pay
   from shift_overtime_approvals oa join eligible_shifts s on s.id=oa.shift_id
   join companies co on co.id=oa.company_id
   where oa.company_id=$1 and oa.currency=s.currency
    and date_trunc('week',s.starts_at at time zone co.timezone)::date=oa.week_start
    and date_trunc('week',(s.ends_at-interval '1 microsecond') at time zone co.timezone)::date=oa.week_start
   group by oa.shift_id
  ), totals as (
   select s.employee_id,
    sum(case when s.pay_type='HOURLY' then greatest(0,s.duration_hours-s.break_minutes::numeric/60-coalesce(ap.hours,0)) else 0 end) as regular_hours,
    sum(case when s.pay_type='HOURLY' then greatest(0,s.duration_hours-s.break_minutes::numeric/60-coalesce(ap.hours,0))*s.hourly_rate else 0 end) as hourly_pay,
    sum(coalesce(ap.hours,0)) as overtime_hours,sum(coalesce(ap.pay,0)) as overtime_pay,
    count(*)::int as shift_count
   from eligible_shifts s left join approved ap on ap.shift_id=s.id group by s.employee_id
  ) select e.id as "employeeId",concat(e.first_name,' ',e.last_name) as "employeeName",cp.pay_type as "payType",cp.currency,
   round(coalesce(t.regular_hours,0),2)::float as "regularHours",
   round(case when cp.pay_type='MONTHLY' then cp.monthly_salary else coalesce(t.hourly_pay,0) end,2)::float as "regularPay",
   round(coalesce(t.overtime_hours,0),2)::float as "overtimeHours",round(coalesce(t.overtime_pay,0),2)::float as "overtimePay",
   round((case when cp.pay_type='MONTHLY' then cp.monthly_salary else coalesce(t.hourly_pay,0) end)+coalesce(t.overtime_pay,0),2)::float as "grossPay",
   coalesce(t.shift_count,0)::int as "eligibleShifts"
   from employee_compensation_profiles cp join employees e on e.id=cp.employee_id and e.company_id=cp.company_id
   left join totals t on t.employee_id=cp.employee_id where cp.company_id=$1
   order by "employeeName"`,[a.companyId,p.month]);
  const excluded=await db.query(`select count(*)::int as count from shifts s join companies co on co.id=s.company_id
   where s.company_id=$1 and (to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2 or to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2)
   and (s.published=false or to_char(s.starts_at at time zone co.timezone,'YYYY-MM')<>$2 or to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')<>$2)`,[a.companyId,p.month]);
  const reviews=await db.query(`select count(*) filter(where pr.decision='CANCELLED')::int as cancelled,
   count(*) filter(where pr.decision='REASSIGNMENT_REQUIRED')::int as pending
   from payroll_shift_reviews pr join shifts s on s.id=pr.shift_id and s.company_id=pr.company_id
   join companies co on co.id=s.company_id
   where pr.company_id=$1 and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
   and to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2`,[a.companyId,p.month]);
  return{ok:true,month:p.month,employees:result.rows,excludedShifts:Number(excluded.rows[0].count),cancelledShifts:Number(reviews.rows[0].cancelled),pendingReassignments:Number(reviews.rows[0].pending),notice:'Read-only provisional gross pay, not a payslip. Hourly pay uses published scheduled hours less unpaid breaks and eligible approved overtime hours; monthly salaries are fixed. Only shifts wholly within the company-local month count. Cross-month and unpublished shifts are excluded. Manager-cancelled shifts are excluded from scheduled hourly pay and approved overtime; monthly base salaries remain fixed. Missing attendance alone does not reduce scheduled pay. Reassignment requests, unapproved overtime, taxes, deductions and historical pay-rate changes are NOT reconciled. Manager review is required before finalisation.'};
 });
 route('GET','/v1/admin/scheduling/payroll-overtime-preview',async(req,a)=>{
 const p=z.object({month:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)}).parse(req.query);
 const r=await db.query(`select oa.employee_id as "employeeId",
 concat(e.first_name,' ',e.last_name) as "employeeName",
 oa.currency,
 round(sum(oa.overtime_hours),2)::float as "approvedHours",
 round(sum(oa.overtime_hours*oa.approved_hourly_rate),2)::float as "overtimePay",
 count(*)::int as "approvalCount"
 from shift_overtime_approvals oa
 join shifts s on s.id=oa.shift_id and s.company_id=oa.company_id and s.published=true
 join employees e on e.id=oa.employee_id
 join companies co on co.id=oa.company_id
 where oa.company_id=$1
 and date_trunc('week',s.starts_at at time zone co.timezone)::date=oa.week_start
 and date_trunc('week',(s.ends_at-interval '1 microsecond') at time zone co.timezone)::date=oa.week_start
 and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
 and to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2
 group by oa.employee_id,e.first_name,e.last_name,oa.currency
 order by "employeeName"`,[a.companyId,p.month]);
 const exclusions=await db.query(`select count(*)::int as count from shift_overtime_approvals oa
 join shifts s on s.id=oa.shift_id and s.company_id=oa.company_id
 join companies co on co.id=oa.company_id
 where oa.company_id=$1 and (to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
 or to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')=$2)
 and (s.published=false
 or date_trunc('week',s.starts_at at time zone co.timezone)::date<>oa.week_start
 or date_trunc('week',(s.ends_at-interval '1 microsecond') at time zone co.timezone)::date<>oa.week_start
 or to_char(s.starts_at at time zone co.timezone,'YYYY-MM')<>$2
 or to_char((s.ends_at-interval '1 microsecond') at time zone co.timezone,'YYYY-MM')<>$2)`,[a.companyId,p.month]);
 return{ok:true,month:p.month,employees:r.rows,excludedApprovals:Number(exclusions.rows[0].count),notice:'Read-only preview of approved overtime for shifts entirely within the selected local month and approval week. Cross-week, cross-month, and unpublished shifts are excluded for manual review. No payslips or payroll entries are created.'};
});
 route('GET','/v1/admin/scheduling/overtime-approvals',async(_req,a)=>{const r=await db.query(`select oa.id,oa.shift_id as "shiftId",oa.employee_id as "employeeId",oa.week_start as "weekStart",oa.overtime_hours::float as "overtimeHours",oa.pay_method as "payMethod",oa.approved_hourly_rate::float as "approvedHourlyRate",oa.currency,oa.approved_at as "approvedAt",oa.approved_by as "approvedBy"
 from shift_overtime_approvals oa join shifts s on s.id=oa.shift_id and s.company_id=oa.company_id
 where oa.company_id=$1 and s.published=true order by oa.approved_at desc limit 500`,[a.companyId]);return{ok:true,approvals:r.rows}});
 route('DELETE','/v1/admin/scheduling/shifts/:shiftId/overtime-approval',async(req,a)=>{
 const shiftId=id(req,'shiftId');
 return tx(async c=>{
  const r=await c.query(`select oa.id from shift_overtime_approvals oa
   join shifts s on s.id=oa.shift_id and s.company_id=oa.company_id
   where oa.company_id=$1 and oa.shift_id=$2 for update of oa`,[a.companyId,shiftId]);
  if(!r.rowCount)throw new ScheduleError('OVERTIME_APPROVAL_NOT_FOUND',404);
  await c.query('delete from shift_overtime_approvals where company_id=$1 and shift_id=$2',[a.companyId,shiftId]);
  await audit(c,a,'REVOKE_SHIFT_OVERTIME','SHIFT',shiftId);
  return{ok:true,revoked:r.rowCount};
 });
});
 route('POST','/v1/admin/scheduling/shifts/:shiftId/overtime-approval',async(req,a)=>{
  const shiftId=id(req,'shiftId');
  const p=z.object({payMethod:z.enum(['NORMAL_RATE','MULTIPLIER','CUSTOM_HOURLY']),baseHourlyRate:z.number().finite().min(0).max(1000000).optional(),multiplier:z.number().finite().positive().max(10).optional(),customHourlyRate:z.number().finite().min(0).max(1000000).optional()}).parse(req.body);
  if((p.payMethod==='NORMAL_RATE'||p.payMethod==='MULTIPLIER')&&p.baseHourlyRate===undefined)throw new ScheduleError('BASE_RATE_REQUIRED',400);
  if(p.payMethod==='MULTIPLIER'&&p.multiplier===undefined)throw new ScheduleError('MULTIPLIER_REQUIRED',400);
  if(p.payMethod==='CUSTOM_HOURLY'&&p.customHourlyRate===undefined)throw new ScheduleError('CUSTOM_RATE_REQUIRED',400);
  const rate=p.payMethod==='CUSTOM_HOURLY'?p.customHourlyRate!:p.baseHourlyRate!*(p.payMethod==='MULTIPLIER'?p.multiplier!:1);
  return tx(async c=>{
   const r=await c.query(`select s.id,s.employee_id,s.starts_at,s.ends_at,s.break_minutes,s.published,co.timezone,co.currency,coalesce(pr.max_weekly_hours,40)::float as weekly_limit
   from shifts s join companies co on co.id=s.company_id left join employee_schedule_profiles pr on pr.company_id=s.company_id and pr.employee_id=s.employee_id
   where s.company_id=$1 and s.id=$2 for update of s`,[a.companyId,shiftId]);
   if(!r.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);
   const sh=r.rows[0];
   if(!sh.published)throw new ScheduleError('PUBLISH_SHIFT_BEFORE_OVERTIME_APPROVAL',409);
   await lockEmployees(c,a.companyId,[sh.employee_id]);
   const weekly=await c.query(`with bounds as (
     select date_trunc('week',$3::timestamptz at time zone $4)::date as week_start,
     date_trunc('week',$3::timestamptz at time zone $4) at time zone $4 as from_at,
     (date_trunc('week',$3::timestamptz at time zone $4)+interval '7 days') at time zone $4 as to_at
   ), segments as (
     select x.id,x.starts_at,x.ends_at,x.break_minutes,b.week_start,
     greatest(x.starts_at,b.from_at) as segment_start,
     least(x.ends_at,b.to_at) as segment_end
     from bounds b join shifts x on x.company_id=$1 and x.employee_id=$2
       and x.starts_at<b.to_at and x.ends_at>b.from_at
   ), hours as (
     select id,starts_at,week_start,
     greatest(0,extract(epoch from(segment_end-segment_start))/3600*
       greatest(0,1-break_minutes/nullif(extract(epoch from(ends_at-starts_at))/60,0))) as hours
     from segments
   ) select week_start,
   coalesce(sum(hours) filter(where starts_at<$6::timestamptz or (starts_at=$6::timestamptz and id<$5::uuid)),0)::float as prior_hours,
   coalesce(sum(hours) filter(where id=$5::uuid),0)::float as shift_hours
   from hours group by week_start`,[a.companyId,sh.employee_id,sh.starts_at,sh.timezone,shiftId,sh.starts_at]);
   if(!weekly.rowCount)throw new ScheduleError('SHIFT_WEEK_NOT_FOUND',409);
   const prior=Number(weekly.rows[0].prior_hours),limit=Number(sh.weekly_limit);
   const shiftHours=Number(weekly.rows[0].shift_hours);
   const overtime=Math.max(0,prior+shiftHours-limit)-Math.max(0,prior-limit);
   if(overtime<=0)throw new ScheduleError('NO_OVERTIME_TO_APPROVE',409);
   if(!Number.isFinite(rate)||rate<0||rate>1000000)throw new ScheduleError('INVALID_OVERTIME_RATE',400);
   const approval=await c.query(`insert into shift_overtime_approvals(company_id,shift_id,employee_id,week_start,overtime_hours,pay_method,approved_hourly_rate,currency,approved_by)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9)
   on conflict(shift_id,week_start) do update set overtime_hours=excluded.overtime_hours,pay_method=excluded.pay_method,approved_hourly_rate=excluded.approved_hourly_rate,currency=excluded.currency,approved_by=excluded.approved_by,approved_at=now()
   returning id,overtime_hours as "overtimeHours",approved_hourly_rate as "approvedHourlyRate",currency`,
   [a.companyId,shiftId,sh.employee_id,weekly.rows[0].week_start,Math.round(overtime*100)/100,p.payMethod,Math.round(rate*10000)/10000,sh.currency,a.adminId||null]);
   await audit(c,a,'APPROVE_SHIFT_OVERTIME','SHIFT',shiftId);
   return{ok:true,approval:approval.rows[0],notice:'Approval records the manager rate. Payroll integration is not yet enabled.'};
  });
 });
 route('GET','/v1/admin/scheduling/assigned-hours',async(_req,a)=>{const r=await db.query(`select s.employee_id as "employeeId",s.branch_id as "branchId",count(*)::int as "shiftCount",coalesce(sum(extract(epoch from (s.ends_at-s.starts_at))/3600),0)::float as "grossHours",coalesce(sum(least(greatest(s.break_minutes,0),extract(epoch from (s.ends_at-s.starts_at))/60))/60,0)::float as "breakHours" from shifts s where s.company_id=$1 group by s.employee_id,s.branch_id`,[a.companyId]);return{ok:true,totals:r.rows}});
 route('GET','/v1/admin/scheduling/calendar',async(req,a)=>{const p=rangeSchema.parse(req.query);const result=await db.query(`select ${shiftColumns} from shifts s join employees e on e.id=s.employee_id join branches b on b.id=s.branch_id join companies co on co.id=s.company_id where s.company_id=$1 and s.starts_at<($3::date+1)::timestamp at time zone co.timezone and s.ends_at>$2::date::timestamp at time zone co.timezone order by s.starts_at,e.first_name limit 10001`,[a.companyId,p.from,p.to]);return{ok:true,shifts:result.rows.slice(0,10000),truncated:result.rows.length>10000}});
 route('GET','/v1/admin/scheduling/patterns',async(_req,a)=>{const r=await db.query(`select p.id,p.employee_id as "employeeId",p.branch_id as "branchId",p.name,p.weekdays,p.start_time::text as "startTime",p.end_time::text as "endTime",p.break_minutes as "breakMinutes",concat(e.first_name,' ',e.last_name) as "employeeName",b.name as "branchName",b.timezone from shift_patterns p join employees e on e.id=p.employee_id join branches b on b.id=p.branch_id where p.company_id=$1 and p.active=true order by p.name,e.first_name`,[a.companyId]);return{ok:true,patterns:r.rows}});
 route('POST','/v1/admin/scheduling/patterns',async(req,a)=>{
  const p=z.object({name:z.string().trim().min(1).max(100),employeeIds:ids,branchId:z.uuid(),weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),...times}).refine(validTimes,'End time must differ from start and the break must be shorter than the shift').parse(req.body);
  return tx(async c=>{await lockEmployees(c,a.companyId,p.employeeIds);const branch=await c.query('select id from branches where id=$1 and company_id=$2 and active=true',[p.branchId,a.companyId]);if(!branch.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);const result=[];for(const employee of [...new Set(p.employeeIds)]){const r=await c.query(`insert into shift_patterns(company_id,employee_id,branch_id,name,weekdays,start_time,end_time,break_minutes) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,[a.companyId,employee,p.branchId,p.name,[...new Set(p.weekdays)],p.startTime,p.endTime,p.breakMinutes]);result.push(r.rows[0].id)}await audit(c,a,'CREATE_REPEATING_PATTERNS','BRANCH',p.branchId);return{ok:true,created:result.length}});
 });
 route('DELETE','/v1/admin/scheduling/patterns/:patternId',async(req,a)=>tx(async c=>{const pattern=id(req,'patternId');const r=await c.query('update shift_patterns set active=false where id=$1 and company_id=$2 returning id',[pattern,a.companyId]);if(!r.rowCount)throw new ScheduleError('PATTERN_NOT_FOUND',404);await audit(c,a,'DISABLE_REPEATING_PATTERN','SHIFT_PATTERN',pattern);return{ok:true}}));
 route('POST','/v1/admin/scheduling/generate',async(req,a)=>{
  const p=rangeSchema.safeExtend({patternIds:z.array(z.uuid()).min(1).max(1000)}).parse(req.body);
  return tx(async c=>{
   const patterns=await c.query('select employee_id from shift_patterns where company_id=$1 and active=true and id=ANY($2::uuid[])',[a.companyId,[...new Set(p.patternIds)]]);if(patterns.rowCount!==new Set(p.patternIds).size)throw new ScheduleError('PATTERN_NOT_FOUND',404);await lockEmployees(c,a.companyId,patterns.rows.map(r=>r.employee_id));
   const candidates=await c.query(`select p.id as "patternId",p.employee_id as "employeeId",p.branch_id as "branchId",p.break_minutes as "breakMinutes",concat(e.first_name,' ',e.last_name) as "employeeName",b.name as "branchName",
    (($2::date+g.n)+p.start_time) at time zone b.timezone as "startsAt",
    (($2::date+g.n+case when p.end_time<=p.start_time then 1 else 0 end)+p.end_time) at time zone b.timezone as "endsAt"
    from shift_patterns p join branches b on b.id=p.branch_id and b.company_id=p.company_id join employees e on e.id=p.employee_id
    cross join generate_series(0,($3::date-$2::date)) g(n) where p.company_id=$1 and p.active=true and b.active=true and e.active=true and p.id=ANY($4::uuid[]) and extract(isodow from ($2::date+g.n))::int=ANY(p.weekdays) order by p.employee_id,"startsAt" limit 5001`,[a.companyId,p.from,p.to,p.patternIds]);
   if(candidates.rows.length>5000)throw new ScheduleError('GENERATE_SMALLER_DATE_RANGE',400);let created=0,existing=0;const conflicts=[];const needsCover=[];
   for(const row of candidates.rows){const start=new Date(row.startsAt),end=new Date(row.endsAt);const prior=await c.query('select id from shifts where pattern_id=$1 and starts_at=$2',[row.patternId,start]);if(prior.rowCount){existing++;continue}let reason=start.getTime()<Date.now()?'SHIFT_IN_PAST':await checkAssignment(c,a.companyId,row.employeeId,row.branchId,start,end);const unavailable=reason==='EMPLOYEE_UNAVAILABLE';if(unavailable)reason='';if(!reason){const hoursWarning=await checkHours(c,a.companyId,row.employeeId,start,netShiftHours(start,end,row.breakMinutes));if(hoursWarning&&hoursWarning!=='WEEKLY_HOURS_EXCEEDED')reason=hoursWarning;}if(netShiftHours(start,end,row.breakMinutes)<=0)reason='BREAK_EXCEEDS_SHIFT';if(reason){conflicts.push({...row,reason});continue}await c.query('insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,break_minutes,pattern_id,published) values($1,$2,$3,$4,$5,$6,$7,false)',[a.companyId,row.employeeId,row.branchId,start,end,row.breakMinutes,row.patternId]);created++;if(unavailable)needsCover.push(row)}
   await audit(c,a,'GENERATE_DRAFT_SCHEDULE','COMPANY',a.companyId);return{ok:true,created,existing,conflicts,needsCover};
  });
 });
 route('POST','/v1/admin/scheduling/publish',async(req,a)=>{
  const p=z.object({shiftIds:ids}).parse(req.body);return tx(async c=>{const r=await c.query('select id,employee_id,starts_at,ends_at from shifts where company_id=$1 and id=ANY($2::uuid[]) and published=false order by id',[a.companyId,[...new Set(p.shiftIds)]]);if(r.rowCount!==new Set(p.shiftIds).size)throw new ScheduleError('DRAFT_NOT_FOUND');await lockEmployees(c,a.companyId,r.rows.map(r=>r.employee_id));const locked=await c.query('select id,employee_id,starts_at from shifts where company_id=$1 and id=ANY($2::uuid[]) and published=false order by id for update',[a.companyId,[...new Set(p.shiftIds)]]);if(locked.rowCount!==r.rowCount||locked.rows.some(s=>!r.rows.some(x=>x.id===s.id&&x.employee_id===s.employee_id)))throw new ScheduleError('SCHEDULE_CHANGED_RETRY');for(const s of locked.rows){if(new Date(s.starts_at).getTime()<Date.now())throw new ScheduleError('SHIFT_IN_PAST');const unavailable=await c.query(`select ${shiftColumns} from shifts s join employees e on e.id=s.employee_id join branches b on b.id=s.branch_id where s.id=$1 and s.company_id=$2`,[s.id,a.companyId]);if(unavailable.rows[0]?.needsCover)throw new ScheduleError('EMPLOYEE_UNAVAILABLE');await c.query('update shifts set published=true where id=$1 and company_id=$2',[s.id,a.companyId])}// Mark recurrence complete only when every associated shift is published.
  await c.query(`update rota_occurrences o set status='PUBLISHED'
   where o.id in (select distinct rota_occurrence_id from shifts where company_id=$1 and id=ANY($2::uuid[]) and rota_occurrence_id is not null)
   and o.status='DRAFT'
   and exists(select 1 from shifts x where x.rota_occurrence_id=o.id)
   and not exists(select 1 from shifts x where x.rota_occurrence_id=o.id and x.published=false)`,[a.companyId,[...new Set(p.shiftIds)]]);
  for(const employee of new Set<string>(r.rows.map(r=>r.employee_id)))await notice(c,a.companyId,employee,'Your manager published new shifts. Check your schedule.');await audit(c,a,'PUBLISH_SCHEDULE','COMPANY',a.companyId);return{ok:true,published:r.rowCount}});
 });
 route('GET','/v1/admin/scheduling/day-off-rules',async(_req,a)=>{const r=await db.query('select id,employee_id as "employeeId",frequency,weekdays,month_days as "monthDays",starts_on as "startsOn",ends_on as "endsOn" from employee_day_off_rules where company_id=$1 and active=true order by starts_on desc',[a.companyId]);return{ok:true,rules:r.rows}});
 route('POST','/v1/admin/scheduling/day-off-rules',async(req,a)=>{const p=z.object({employeeId:z.uuid(),frequency:z.enum(['WEEKLY','MONTHLY']),weekdays:z.array(z.number().int().min(1).max(7)).default([]),monthDays:z.array(z.number().int().min(1).max(31)).default([]),startsOn:z.iso.date(),endsOn:z.iso.date().nullable().optional()}).refine(v=>v.frequency==='WEEKLY'?v.weekdays.length>0:v.monthDays.length>0,'Select recurrence days').refine(v=>!v.endsOn||v.endsOn>=v.startsOn,'End must not precede start').refine(v=>v.frequency==='WEEKLY'?v.monthDays.length===0:v.weekdays.length===0,'Select days for the chosen recurrence only').refine(v=>new Set(v.weekdays).size===v.weekdays.length&&new Set(v.monthDays).size===v.monthDays.length,'Recurrence days must be unique').parse(req.body);return tx(async c=>{await lockEmployees(c,a.companyId,[p.employeeId]);const employee=await c.query('select 1 from employees where id=$1 and company_id=$2 and active=true',[p.employeeId,a.companyId]);if(!employee.rowCount)throw new ScheduleError('EMPLOYEE_NOT_FOUND',404);const r=await c.query('insert into employee_day_off_rules(company_id,employee_id,frequency,weekdays,month_days,starts_on,ends_on) values($1,$2,$3,$4,$5,$6,$7) returning id',[a.companyId,p.employeeId,p.frequency,p.weekdays,p.monthDays,p.startsOn,p.endsOn||null]);await audit(c,a,'CREATE_DAY_OFF_RULE','EMPLOYEE',p.employeeId);return{ok:true,id:r.rows[0].id}})});
 route('DELETE','/v1/admin/scheduling/day-off-rules/:ruleId',async(req,a)=>tx(async c=>{const rule=id(req,'ruleId');const r=await c.query('update employee_day_off_rules set active=false where id=$1 and company_id=$2 and active=true returning employee_id',[rule,a.companyId]);if(!r.rowCount)throw new ScheduleError('DAY_OFF_RULE_NOT_FOUND',404);await audit(c,a,'STOP_DAY_OFF_RULE','EMPLOYEE',r.rows[0].employee_id);return{ok:true}}));
 route('GET','/v1/admin/scheduling/unavailability',async(req,a)=>{const p=rangeSchema.parse(req.query);const r=await db.query(`select u.id,u.employee_id as "employeeId",concat(e.first_name,' ',e.last_name) as "employeeName",u.starts_at as "startsAt",u.ends_at as "endsAt",u.category from employee_unavailability u join employees e on e.id=u.employee_id join companies co on co.id=u.company_id where u.company_id=$1 and u.active=true and u.starts_at<($3::date+1)::timestamp at time zone co.timezone and (u.ends_at is null or u.ends_at>$2::date::timestamp at time zone co.timezone) order by u.starts_at`,[a.companyId,p.from,p.to]);return{ok:true,unavailability:r.rows}});
 route('POST','/v1/admin/scheduling/unavailability',async(req,a)=>{
  const p=z.object({employeeId:z.uuid(),fromDate:z.iso.date(),toDate:z.iso.date().nullable(),category:z.enum(['ABSENCE','INJURY','LEAVE','DAY_OFF','SICKNESS']),startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()}).refine(v=>v.toDate===null?['INJURY','SICKNESS'].includes(v.category):validDateRange(v.fromDate,v.toDate,367)).refine(v=>!v.startTime&&!v.endTime||(v.category==='ABSENCE'&&!!v.startTime&&!!v.endTime&&v.toDate===v.fromDate&&v.endTime>v.startTime),'Hourly absences require a single day and an end time after the start time').parse(req.body);
  return tx(async c=>{await lockEmployees(c,a.companyId,[p.employeeId]);const employee=await c.query('select 1 from employees where id=$1 and company_id=$2 and active=true',[p.employeeId,a.companyId]);if(!employee.rowCount)throw new ScheduleError('EMPLOYEE_NOT_FOUND',404);const r=await c.query('insert into employee_unavailability(company_id,employee_id,starts_at,ends_at,category) select $1,$2,($3::date::timestamp+coalesce($6::time,make_time(0,0,0))) at time zone timezone,case when $4::date is null then null when $7::time is not null then ($4::date::timestamp+$7::time) at time zone timezone else ($4::date+1)::timestamp at time zone timezone end,$5 from companies where id=$1 returning id',[a.companyId,p.employeeId,p.fromDate,p.toDate,p.category,p.startTime??null,p.endTime??null]);await notice(c,a.companyId,p.employeeId,'Your manager updated your availability. Check your schedule.');await audit(c,a,'RECORD_UNAVAILABILITY','EMPLOYEE',p.employeeId);return{ok:true,id:r.rows[0].id}});
 });
 route('PUT','/v1/admin/scheduling/unavailability/:absenceId/extend',async(req,a)=>{
  const absence=id(req,'absenceId'),p=z.object({toDate:z.iso.date()}).parse(req.body);
  return tx(async c=>{
   const current=await c.query('select employee_id,starts_at,ends_at,category,active from employee_unavailability where id=$1 and company_id=$2 for update',[absence,a.companyId]);
   if(!current.rowCount||!current.rows[0].active)throw new ScheduleError('UNAVAILABILITY_NOT_FOUND',404);
   const row=current.rows[0];if(!['INJURY','SICKNESS'].includes(row.category))throw new ScheduleError('EXTENSION_NOT_ALLOWED',409);
   await lockEmployees(c,a.companyId,[row.employee_id]);
   const dates=await c.query('select ($1::timestamptz at time zone timezone)::date::text as start,($2::timestamptz at time zone timezone)::date::text as finish from companies where id=$3',[row.starts_at,row.ends_at,a.companyId]);
   const fromDate=dates.rows[0].start;
   const endDate=await c.query('select ($1::date+1)::timestamp at time zone timezone as finish from companies where id=$2',[p.toDate,a.companyId]);
   if(!validDateRange(fromDate,p.toDate,367)||new Date(endDate.rows[0].finish).getTime()<=new Date(row.ends_at).getTime())throw new ScheduleError('INVALID_EXTENSION',400);
   await c.query('update employee_unavailability set ends_at=$1 where id=$2 and company_id=$3',[endDate.rows[0].finish,absence,a.companyId]);
   await notice(c,a.companyId,row.employee_id,'Your manager extended your recorded absence. Check your schedule.');
   await audit(c,a,'EXTEND_UNAVAILABILITY','EMPLOYEE',row.employee_id);return{ok:true,id:absence,toDate:p.toDate};
  });
 });
 route('PUT','/v1/admin/scheduling/unavailability/:absenceId/end',async(req,a)=>{
  const absence=id(req,'absenceId'),p=z.object({lastAbsentDate:z.iso.date()}).parse(req.body);
  return tx(async c=>{
   const current=await c.query('select employee_id,starts_at,ends_at,category,active from employee_unavailability where id=$1 and company_id=$2 for update',[absence,a.companyId]);
   if(!current.rowCount||!current.rows[0].active)throw new ScheduleError('UNAVAILABILITY_NOT_FOUND',404);
   const row=current.rows[0];if(!['INJURY','SICKNESS'].includes(row.category)||row.ends_at!==null)throw new ScheduleError('END_ABSENCE_NOT_ALLOWED',409);
   await lockEmployees(c,a.companyId,[row.employee_id]);
   const bounds=await c.query('select ($1::timestamptz at time zone timezone)::date::text as start,($2::date+1)::timestamp at time zone timezone as finish from companies where id=$3',[row.starts_at,p.lastAbsentDate,a.companyId]);
   if(p.lastAbsentDate<bounds.rows[0].start)throw new ScheduleError('INVALID_ABSENCE_END',400);
   await c.query('update employee_unavailability set ends_at=$1 where id=$2 and company_id=$3',[bounds.rows[0].finish,absence,a.companyId]);
   await notice(c,a.companyId,row.employee_id,'Your manager recorded the end of your absence. Check your schedule.');
   await audit(c,a,'END_UNAVAILABILITY','EMPLOYEE',row.employee_id);return{ok:true,id:absence,lastAbsentDate:p.lastAbsentDate};
  });
 });
 route('DELETE','/v1/admin/scheduling/unavailability/:absenceId',async(req,a)=>tx(async c=>{const absence=id(req,'absenceId');const current=await c.query('select employee_id from employee_unavailability where id=$1 and company_id=$2',[absence,a.companyId]);if(!current.rowCount)throw new ScheduleError('UNAVAILABILITY_NOT_FOUND',404);await lockEmployees(c,a.companyId,[current.rows[0].employee_id]);await c.query('update employee_unavailability set active=false where id=$1 and company_id=$2',[absence,a.companyId]);await notice(c,a.companyId,current.rows[0].employee_id,'Your manager removed an availability exception. Check your schedule.');await audit(c,a,'REMOVE_UNAVAILABILITY','EMPLOYEE',current.rows[0].employee_id);return{ok:true}}));
 const coverOptions=async(c:Pick<Pool,'query'>,company:string,shift:any)=>{
  const r=await c.query(`select e.id as "employeeId",concat(e.first_name,' ',e.last_name) as name,coalesce(p.job_role,'') as "jobRole",coalesce(p.max_weekly_hours,40)::float as "maxWeeklyHours",coalesce(p.allowed_branch_ids,'{}'::uuid[]) as "allowedBranches",
   (exists(select 1 from employee_unavailability u where u.company_id=$1 and u.employee_id=e.id and u.active=true and u.starts_at<$4 and (u.ends_at is null or u.ends_at>$3))
   or exists(select 1 from employee_day_off_rules dor where dor.company_id=$1 and dor.employee_id=e.id and dor.active=true and exists(select 1 from generate_series(($3::timestamptz at time zone co.timezone)::date,(($4::timestamptz-interval '1 microsecond') at time zone co.timezone)::date,interval '1 day') as offday(day) where offday.day::date>=dor.starts_on and (dor.ends_on is null or offday.day::date<=dor.ends_on) and ((dor.frequency='WEEKLY' and extract(isodow from offday.day)::int=any(dor.weekdays)) or (dor.frequency='MONTHLY' and extract(day from offday.day)::int=any(dor.month_days)))))) as unavailable,
   exists(select 1 from shifts x where x.company_id=$1 and x.employee_id=e.id and x.id<>$5 and x.starts_at<$4 and x.ends_at>$3) as overlap,
   coalesce((select sum(greatest(0,extract(epoch from(x.ends_at-x.starts_at))/3600-x.break_minutes/60.0)) from shifts x where x.company_id=$1 and x.employee_id=e.id and x.id<>$5 and x.starts_at>=date_trunc('week',$3::timestamptz at time zone co.timezone) at time zone co.timezone and x.starts_at<(date_trunc('week',$3::timestamptz at time zone co.timezone)+interval '7 days') at time zone co.timezone),0)::float as "scheduledHours"
   from employees e join companies co on co.id=e.company_id left join employee_schedule_profiles p on p.employee_id=e.id and p.company_id=e.company_id where e.company_id=$1 and e.active=true and e.id<>$2 order by "scheduledHours",e.first_name`,[company,shift.employee_id,shift.starts_at,shift.ends_at,shift.id]);
  const profile=await c.query('select job_role from employee_schedule_profiles where company_id=$1 and employee_id=$2',[company,shift.employee_id]);const requiredRole=profile.rows[0]?.job_role||'';const hours=netShiftHours(shift.starts_at,shift.ends_at,0);return{requiredRole,candidates:r.rows.filter(row=>eligibleCover(row,shift.branch_id,requiredRole,hours)),hours};
 };
 // Read-only preview: calculate the exact absence/shift intersection without reassigning the original shift.
 route('GET','/v1/admin/scheduling/shifts/:shiftId/partial-cover',async(req,a)=>{
  const shiftId=id(req,'shiftId');
  const found=await db.query('select * from shifts where id=$1 and company_id=$2',[shiftId,a.companyId]);
  if(!found.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);
  const shift=found.rows[0];
  const absent=await db.query(`select greatest(starts_at,$3::timestamptz) as "startsAt",least(coalesce(ends_at,$4::timestamptz),$4::timestamptz) as "endsAt" from employee_unavailability where company_id=$1 and employee_id=$2 and active=true and starts_at<$4 and (ends_at is null or ends_at>$3) order by "startsAt"`,[a.companyId,shift.employee_id,shift.starts_at,shift.ends_at]);
  const intervals=absent.rows.map(row=>({startsAt:row.startsAt,endsAt:row.endsAt}));
  const merged: {startsAt:Date;endsAt:Date}[]=[];
  for(const interval of intervals){const start=new Date(interval.startsAt),end=new Date(interval.endsAt),last=merged.at(-1);if(last&&start<=last.endsAt){if(end>last.endsAt)last.endsAt=end;}else merged.push({startsAt:start,endsAt:end});}
  const uncoveredHours=merged.reduce((sum,interval)=>sum+(interval.endsAt.getTime()-interval.startsAt.getTime())/3600000,0);
  const suggestions=[];
  for(const interval of merged){
   const window={...shift,starts_at:interval.startsAt,ends_at:interval.endsAt,break_minutes:0};
   const options=await coverOptions(db,a.companyId,window);
   suggestions.push({startsAt:interval.startsAt,endsAt:interval.endsAt,hours:(interval.endsAt.getTime()-interval.startsAt.getTime())/3600000,requiredRole:options.requiredRole,candidates:options.candidates});
  }
  return{ok:true,shiftId,employeeId:shift.employee_id,intervals:merged,uncoveredHours,suggestions,requiresManagerApproval:true,originalShiftUnchanged:true};
 });
 // Manager-selected partial cover creates a draft only; publishing remains a separate approval action.
 route('POST','/v1/admin/scheduling/shifts/:shiftId/partial-cover',async(req,a)=>{
  const shiftId=id(req,'shiftId'),p=z.object({employeeId:z.uuid(),startsAt:z.iso.datetime({offset:true}),endsAt:z.iso.datetime({offset:true})}).parse(req.body);
  return tx(async c=>{
   const source=await c.query('select * from shifts where id=$1 and company_id=$2 for update',[shiftId,a.companyId]);
   if(!source.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);
   const shift=source.rows[0],start=new Date(p.startsAt),end=new Date(p.endsAt);
   if(start>=end||start<new Date(shift.starts_at)||end>new Date(shift.ends_at))throw new ScheduleError('INVALID_COVER_WINDOW',400);
   if(end.getTime()<=Date.now())throw new ScheduleError('SHIFT_IN_PAST');
   await lockEmployees(c,a.companyId,[shift.employee_id,p.employeeId]);
   const missing=await c.query('select 1 from employee_unavailability where company_id=$1 and employee_id=$2 and active=true and starts_at<=$3 and (ends_at is null or ends_at>=$4)',[a.companyId,shift.employee_id,start,end]);
   if(!missing.rowCount)throw new ScheduleError('COVER_WINDOW_NOT_ABSENT');
   const window={...shift,starts_at:start,ends_at:end,break_minutes:0};
   const options=await coverOptions(c,a.companyId,window);
   if(!options.candidates.some(row=>row.employeeId===p.employeeId))throw new ScheduleError('COVER_NO_LONGER_AVAILABLE');
   const created=await c.query('insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,break_minutes,published) values($1,$2,$3,$4,$5,0,false) returning id',[a.companyId,p.employeeId,shift.branch_id,start,end]);
   await audit(c,a,'CREATE_PARTIAL_COVER_DRAFT','SHIFT',created.rows[0].id);
   return{ok:true,draftShiftId:created.rows[0].id,originalShiftId:shiftId,published:false,requiresManagerApproval:true};
  });
 });
 route('GET','/v1/admin/scheduling/shifts/:shiftId/cover',async(req,a)=>{const shift=id(req,'shiftId');const r=await db.query('select * from shifts where id=$1 and company_id=$2',[shift,a.companyId]);if(!r.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);const attendance=await db.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');return{ok:true,...await coverOptions(db,a.companyId,r.rows[0])}});
 route('POST','/v1/admin/scheduling/shifts/:shiftId/cover',async(req,a)=>{
  const shift=id(req,'shiftId'),p=z.object({employeeId:z.uuid()}).parse(req.body);return tx(async c=>{const r=await c.query('select * from shifts where id=$1 and company_id=$2',[shift,a.companyId]);if(!r.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);const original=r.rows[0];if(new Date(original.ends_at).getTime()<=Date.now())throw new ScheduleError('SHIFT_IN_PAST');await lockEmployees(c,a.companyId,[original.employee_id,p.employeeId]);const locked=await c.query('select * from shifts where id=$1 and company_id=$2 for update',[shift,a.companyId]);if(!locked.rowCount||locked.rows[0].employee_id!==original.employee_id)throw new ScheduleError('SCHEDULE_CHANGED_RETRY');Object.assign(original,locked.rows[0]);const attendance=await c.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');const options=await coverOptions(c,a.companyId,original);if(!options.candidates.some(row=>row.employeeId===p.employeeId))throw new ScheduleError('COVER_NO_LONGER_AVAILABLE');await c.query('update shifts set employee_id=$1 where id=$2 and company_id=$3',[p.employeeId,shift,a.companyId]);if(original.published){await notice(c,a.companyId,original.employee_id,'A shift was reassigned by your manager. Check your updated schedule.');await notice(c,a.companyId,p.employeeId,'Your manager assigned you a replacement shift. Check your updated schedule.')}await audit(c,a,'ASSIGN_SHIFT_COVER','SHIFT',shift);return{ok:true}});
 });
 app.get('/v1/employee/schedule',async(req,reply)=>{
  reply.header('Cache-Control','no-store');const a=await authenticateEmployee(db,req.headers.authorization);if(!a)return reply.code(401).send({ok:false,error:'EMPLOYEE_AUTH_REQUIRED'});
  const parsed=rangeSchema.safeParse(req.query);if(!parsed.success)return reply.code(400).send({ok:false,error:'INVALID_DATE_RANGE'});const p=parsed.data;
  const [shifts,unavailable,notices]=await Promise.all([db.query(`select s.id,b.name as "branchName",s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes",(select min(occurred_at) from attendance_events where shift_id=s.id and employee_id=$2 and action='CHECK_IN') as "checkInAt",(select max(occurred_at) from attendance_events where shift_id=s.id and employee_id=$2 and action='CHECK_OUT') as "checkOutAt" from shifts s join branches b on b.id=s.branch_id join companies co on co.id=s.company_id where s.company_id=$1 and s.employee_id=$2 and s.published=true and s.starts_at<($4::date+1)::timestamp at time zone co.timezone and s.ends_at>$3::date::timestamp at time zone co.timezone order by s.starts_at`,[a.companyId,a.employeeId,p.from,p.to]),db.query(`select u.starts_at as "startsAt",u.ends_at as "endsAt" from employee_unavailability u join companies co on co.id=u.company_id where u.company_id=$1 and u.employee_id=$2 and u.active=true and u.starts_at<($4::date+1)::timestamp at time zone co.timezone and (u.ends_at is null or u.ends_at>$3::date::timestamp at time zone co.timezone) order by u.starts_at`,[a.companyId,a.employeeId,p.from,p.to]),db.query(`select id,message,created_at as "createdAt" from schedule_notices where company_id=$1 and employee_id=$2 order by created_at desc limit 10`,[a.companyId,a.employeeId])]);return{ok:true,shifts:shifts.rows,unavailability:unavailable.rows,notices:notices.rows};
 });
}
