import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { requireAdmin, type AdminToken } from './admin-auth.js';
import { authenticateEmployee } from './employee-routes.js';
import { eligibleCover, netShiftHours, validDateRange } from './scheduling-rules.js';
const rangeSchema=z.object({from:z.iso.date(),to:z.iso.date()}).refine(v=>validDateRange(v.from,v.to),'Select at most 62 days');
const times={startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),breakMinutes:z.number().int().min(0).max(720)};
const validTimes=(p:{startTime:string;endTime:string;breakMinutes:number})=>{const minutes=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3));const duration=(minutes(p.endTime)-minutes(p.startTime)+1440)%1440;return duration>p.breakMinutes};
const ids=z.array(z.uuid()).min(1).max(500);
class ScheduleError extends Error { constructor(public code:string,public status=409){super(code)} }
const id=(req:FastifyRequest,key:string)=>z.uuid().parse((req.params as Record<string,string>)[key]);
const shiftColumns=`s.id,s.employee_id as "employeeId",s.branch_id as "branchId",s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes",s.published,concat(e.first_name,' ',e.last_name) as "employeeName",e.employee_number as "employeeNumber",b.name as "branchName",b.timezone,
 exists(select 1 from employee_unavailability u where u.company_id=s.company_id and u.employee_id=s.employee_id and u.active=true and u.starts_at<s.ends_at and u.ends_at>s.starts_at) as "needsCover",
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
  const absent=await c.query('select 1 from employee_unavailability where company_id=$1 and employee_id=$2 and active=true and starts_at<$4 and ends_at>$3 limit 1',[company,employee,start,end]);if(absent.rowCount)return 'EMPLOYEE_UNAVAILABLE';
  const profile=await c.query('select allowed_branch_ids from employee_schedule_profiles where company_id=$1 and employee_id=$2',[company,employee]);const allowed=profile.rows[0]?.allowed_branch_ids||[];if(allowed.length&&!allowed.includes(branch))return 'BRANCH_NOT_ALLOWED';return '';
 };
 const checkHours=async(c:PoolClient,company:string,employee:string,start:Date,hours:number)=>{const r=await c.query(`select coalesce(p.max_weekly_hours,40)::float as "limit",coalesce((select sum(greatest(0,extract(epoch from(x.ends_at-x.starts_at))/3600-x.break_minutes/60.0)) from shifts x where x.company_id=$1 and x.employee_id=$2 and x.starts_at>=date_trunc('week',$3::timestamptz at time zone co.timezone) at time zone co.timezone and x.starts_at<(date_trunc('week',$3::timestamptz at time zone co.timezone)+interval '7 days') at time zone co.timezone),0)::float as hours from companies co left join employee_schedule_profiles p on p.company_id=co.id and p.employee_id=$2 where co.id=$1`,[company,employee,start]);return Number(r.rows[0].hours)+hours>Number(r.rows[0].limit)?'WEEKLY_HOURS_EXCEEDED':''};
 route('POST','/v1/admin/scheduling/drafts',async(req,a)=>{const p=z.object({employeeIds:ids,branchId:z.uuid(),date:z.iso.date(),...times}).refine(validTimes,'Break must be shorter than the shift; start and end must differ').parse(req.body);return tx(async c=>{await lockEmployees(c,a.companyId,p.employeeIds);const b=await c.query(`select ($3::date+$4::time) at time zone timezone as start,($3::date+case when $5::time<=$4::time then 1 else 0 end+$5::time) at time zone timezone as "end" from branches where id=$1 and company_id=$2 and active=true`,[p.branchId,a.companyId,p.date,p.startTime,p.endTime]);if(!b.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);const start=new Date(b.rows[0].start),end=new Date(b.rows[0].end);if(start.getTime()<Date.now())throw new ScheduleError('SHIFT_IN_PAST');for(const employee of [...new Set(p.employeeIds)]){const conflict=await checkAssignment(c,a.companyId,employee,p.branchId,start,end);if(conflict&&conflict!=='EMPLOYEE_UNAVAILABLE')throw new ScheduleError(conflict);const hours=await checkHours(c,a.companyId,employee,start,netShiftHours(start,end,p.breakMinutes));if(hours)throw new ScheduleError(hours);await c.query('insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,break_minutes,published) values($1,$2,$3,$4,$5,$6,false)',[a.companyId,employee,p.branchId,start,end,p.breakMinutes])}await audit(c,a,'CREATE_DRAFT_SHIFTS','BRANCH',p.branchId);return{ok:true,created:new Set(p.employeeIds).size}})});
 route('GET','/v1/admin/scheduling/meta',async(_req,a)=>{
  const [employees,branches,company]=await Promise.all([db.query(`select e.id,concat(e.first_name,' ',e.last_name) as name,e.employee_number as "employeeNumber",coalesce(p.job_role,'') as "jobRole",coalesce(p.max_weekly_hours,40) as "maxWeeklyHours",coalesce(p.allowed_branch_ids,'{}'::uuid[]) as "allowedBranchIds",p.allowed_branch_ids[1] as "primaryBranchId",coalesce(p.pay_type,'salary') as "payType",coalesce(p.monthly_target_hours,173.33)::float as "monthlyTargetHours",coalesce(p.allocation_priority,3) as "allocationPriority" from employees e left join employee_schedule_profiles p on p.employee_id=e.id and p.company_id=e.company_id where e.company_id=$1 and e.active=true order by e.first_name,e.last_name`,[a.companyId]),db.query('select id,name,timezone from branches where company_id=$1 and active=true order by name',[a.companyId]),db.query('select timezone from companies where id=$1',[a.companyId])]);return{ok:true,employees:employees.rows,branches:branches.rows,timezone:company.rows[0].timezone};
 });
 route('PUT','/v1/admin/scheduling/profiles/:employeeId',async(req,a)=>{
  const employee=id(req,'employeeId'),p=z.object({jobRole:z.string().trim().max(100),maxWeeklyHours:z.number().min(1).max(168),allowedBranchIds:z.array(z.uuid()).max(100).default([]),primaryBranchId:z.uuid().nullable().optional(),payType:z.enum(['salary','hourly']).optional(),monthlyTargetHours:z.number().min(0).max(744).optional(),allocationPriority:z.number().int().min(1).max(5).optional()}).parse(req.body);
  if(p.primaryBranchId&&!p.allowedBranchIds.includes(p.primaryBranchId))throw new ScheduleError('PRIMARY_BRANCH_NOT_ELIGIBLE',400);const branchIds=p.primaryBranchId?[p.primaryBranchId,...p.allowedBranchIds.filter(b=>b!==p.primaryBranchId)]:p.allowedBranchIds;return tx(async c=>{await lockEmployees(c,a.companyId,[employee]);if(p.allowedBranchIds.length){const branches=await c.query('select id from branches where company_id=$1 and active=true and id=ANY($2::uuid[])',[a.companyId,[...new Set(p.allowedBranchIds)]]);if(branches.rowCount!==new Set(p.allowedBranchIds).size)throw new ScheduleError('BRANCH_NOT_FOUND',404)}await c.query(`insert into employee_schedule_profiles(employee_id,company_id,job_role,max_weekly_hours,allowed_branch_ids) values($1,$2,$3,$4,$5) on conflict(employee_id) do update set job_role=excluded.job_role,max_weekly_hours=excluded.max_weekly_hours,allowed_branch_ids=excluded.allowed_branch_ids,pay_type=coalesce($6,employee_schedule_profiles.pay_type),monthly_target_hours=coalesce($7,employee_schedule_profiles.monthly_target_hours),allocation_priority=coalesce($8,employee_schedule_profiles.allocation_priority)`,[employee,a.companyId,p.jobRole,p.maxWeeklyHours,branchIds,p.payType??null,p.monthlyTargetHours??null,p.allocationPriority??null]);await audit(c,a,'UPDATE_SCHEDULE_PROFILE','EMPLOYEE',employee);return{ok:true}});
 });
 route('GET','/v1/admin/scheduling/calendar',async(req,a)=>{const p=rangeSchema.parse(req.query);const result=await db.query(`select ${shiftColumns} from shifts s join employees e on e.id=s.employee_id join branches b on b.id=s.branch_id join companies co on co.id=s.company_id where s.company_id=$1 and s.starts_at<($3::date+1)::timestamp at time zone co.timezone and s.ends_at>$2::date::timestamp at time zone co.timezone order by s.starts_at,e.first_name limit 10001`,[a.companyId,p.from,p.to]);return{ok:true,shifts:result.rows.slice(0,10000),truncated:result.rows.length>10000}});
 route('GET','/v1/admin/scheduling/patterns',async(_req,a)=>{const r=await db.query(`select p.id,p.employee_id as "employeeId",p.branch_id as "branchId",p.name,p.active,p.weekdays,p.start_time::text as "startTime",p.end_time::text as "endTime",p.break_minutes as "breakMinutes",concat(e.first_name,' ',e.last_name) as "employeeName",b.name as "branchName",b.timezone from shift_patterns p join employees e on e.id=p.employee_id join branches b on b.id=p.branch_id where p.company_id=$1 order by p.active desc,p.name,e.first_name`,[a.companyId]);return{ok:true,patterns:r.rows}});
 route('POST','/v1/admin/scheduling/patterns',async(req,a)=>{
  const p=z.object({name:z.string().trim().min(1).max(100),employeeIds:ids,branchId:z.uuid(),weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),...times}).refine(validTimes,'End time must differ from start and the break must be shorter than the shift').parse(req.body);
  return tx(async c=>{await lockEmployees(c,a.companyId,p.employeeIds);const branch=await c.query('select id from branches where id=$1 and company_id=$2 and active=true',[p.branchId,a.companyId]);if(!branch.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);const result=[];for(const employee of [...new Set(p.employeeIds)]){
   const existing=await c.query('SELECT weekdays,start_time::text AS start_time,end_time::text AS end_time,branch_id,break_minutes FROM shift_patterns WHERE company_id=$1 AND employee_id=$2 AND active=true',[a.companyId,employee]);
   const minutes=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
   const spans=(days:number[],start:string,end:string)=>days.map(day=>{const from=(day-1)*1440+minutes(start);const duration=(minutes(end)-minutes(start)+1440)%1440;return [from,from+duration] as const});
   const proposed=spans([...new Set(p.weekdays)],p.startTime,p.endTime);
   for(const prior of existing.rows){
    const old=spans(prior.weekdays,prior.start_time,prior.end_time);
    const overlaps=proposed.some(([a,b])=>old.some(([x,y])=>[-10080,0,10080].some(offset=>a<y+offset&&b>x+offset)));
    if(overlaps){
     const same=prior.branch_id===p.branchId&&prior.break_minutes===p.breakMinutes&&
      prior.start_time.slice(0,5)===p.startTime&&prior.end_time.slice(0,5)===p.endTime&&
      [...prior.weekdays].sort().join(',')===[...new Set(p.weekdays)].sort().join(',');
     throw new ScheduleError(same?'PATTERN_DUPLICATE':'PATTERN_OVERLAP',409);
    }
   }
   const r=await c.query(`insert into shift_patterns(company_id,employee_id,branch_id,name,weekdays,start_time,end_time,break_minutes) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,[a.companyId,employee,p.branchId,p.name,[...new Set(p.weekdays)],p.startTime,p.endTime,p.breakMinutes]);result.push(r.rows[0].id)}await audit(c,a,'CREATE_REPEATING_PATTERNS','BRANCH',p.branchId);return{ok:true,created:result.length}});
 });
 route('DELETE','/v1/admin/scheduling/patterns/:patternId',async(req,a)=>tx(async c=>{const pattern=id(req,'patternId');const r=await c.query('update shift_patterns set active=false where id=$1 and company_id=$2 returning id',[pattern,a.companyId]);if(!r.rowCount)throw new ScheduleError('PATTERN_NOT_FOUND',404);await audit(c,a,'DISABLE_REPEATING_PATTERN','SHIFT_PATTERN',pattern);return{ok:true}}));
 route('DELETE','/v1/admin/scheduling/patterns/:patternId/permanent',async(req,a)=>tx(async c=>{
  const pattern=id(req,'patternId');
  const found=await c.query('SELECT id FROM shift_patterns WHERE id=$1 AND company_id=$2 FOR UPDATE',[pattern,a.companyId]);
  if(!found.rowCount)throw new ScheduleError('PATTERN_NOT_FOUND',404);
  const linked=await c.query('SELECT 1 FROM shifts WHERE pattern_id=$1 LIMIT 1',[pattern]);
  if(linked.rowCount)throw new ScheduleError('PATTERN_HAS_SHIFTS',409);
  await c.query('DELETE FROM shift_patterns WHERE id=$1 AND company_id=$2',[pattern,a.companyId]);
  await audit(c,a,'DELETE_UNUSED_REPEATING_PATTERN','SHIFT_PATTERN',pattern);
  return {ok:true};
 }));
 route('POST','/v1/admin/scheduling/balanced-drafts',async(req,a)=>{
  const p=z.object({branchId:z.uuid(),from:z.iso.date(),staffing:z.array(z.number().int().min(0).max(100)).length(7),employees:z.array(z.object({employeeId:z.uuid(),daysOff:z.array(z.number().int().min(1).max(7)).max(7),maxWeeklyHours:z.number().min(1).max(168)})).min(1).max(100),...times}).refine(validTimes,'Invalid shift or break duration').parse(req.body);
  if(new Set(p.employees.map(e=>e.employeeId)).size!==p.employees.length)throw new ScheduleError('DUPLICATE_EMPLOYEE',400);
  const startDate=new Date(p.from+'T00:00:00Z');if(Number.isNaN(startDate.getTime())||startDate.getUTCDay()!==1)throw new ScheduleError('WEEK_MUST_START_MONDAY',400);
  return tx(async c=>{
   await lockEmployees(c,a.companyId,p.employees.map(e=>e.employeeId));
   const b=await c.query('select id,timezone from branches where id=$1 and company_id=$2 and active=true',[p.branchId,a.companyId]);if(!b.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);
   const employees=await c.query('select e.id,coalesce(sp.max_weekly_hours,40)::float as max_hours,coalesce(sp.allowed_branch_ids,\'{}\'::uuid[]) as allowed_branches from employees e left join employee_schedule_profiles sp on sp.employee_id=e.id and sp.company_id=e.company_id where e.company_id=$1 and e.id=ANY($2::uuid[])',[a.companyId,p.employees.map(e=>e.employeeId)]);
   const lookup=new Map<string,any>(employees.rows.map(e=>[e.id,e]));
   const hours=netShiftHours(new Date('2026-01-01T'+p.startTime+':00Z'),new Date('2026-01-01T'+p.endTime+':00Z').getTime()<=new Date('2026-01-01T'+p.startTime+':00Z').getTime()?new Date('2026-01-02T'+p.endTime+':00Z'):new Date('2026-01-01T'+p.endTime+':00Z'),p.breakMinutes);
   const assigned=new Map<string,number>(p.employees.map(e=>[e.employeeId,0]));
   // Include pre-existing assignments in the fairness calculation; don't treat this run in isolation.
   const weekEnd=new Date(startDate.getTime()+7*86400000).toISOString().slice(0,10);
   const priorWeek=await c.query(`select s.employee_id,count(*)::int as shifts from shifts s join branches b on b.id=s.branch_id where s.company_id=$1 and s.branch_id=$2 and (s.starts_at at time zone b.timezone)::date >= $3::date and (s.starts_at at time zone b.timezone)::date < $4::date group by s.employee_id`,[a.companyId,p.branchId,p.from,weekEnd]);
   for(const row of priorWeek.rows)if(assigned.has(row.employee_id))assigned.set(row.employee_id,Number(row.shifts));
   const unmet:any[]=[];let created=0,existing=0;
   const ordered=p.employees.map(e=>({...e,daysOff:new Set(e.daysOff),cap:Math.min(e.maxWeeklyHours,Number(lookup.get(e.employeeId)?.max_hours||40))}));
   for(let i=0;i<7;i++){
    const day=new Date(startDate.getTime()+i*86400000).toISOString().slice(0,10);
    const slot=await c.query(`select ($2::date+$3::time) at time zone timezone as start,($2::date+case when $4::time<=$3::time then 1 else 0 end+$4::time) at time zone timezone as "end" from branches where id=$1`,[p.branchId,day,p.startTime,p.endTime]);
    const start=new Date(slot.rows[0].start),end=new Date(slot.rows[0].end);
    const already=await c.query('select employee_id from shifts where company_id=$1 and branch_id=$2 and starts_at<$4 and ends_at>$3',[a.companyId,p.branchId,start,end]);
    existing+=(already.rowCount??0);
    if((already.rowCount??0)>p.staffing[i])unmet.push({day,needed:0,excess:(already.rowCount??0)-p.staffing[i],reason:'EXCESS_EXISTING_SHIFTS'});
    let needed=Math.max(0,p.staffing[i]-(already.rowCount??0));
    if(start.getTime()<Date.now()){if(needed)unmet.push({day,needed,reason:'SHIFT_IN_PAST'});continue}
    const ranked=[...ordered].sort((x,y)=>{const px=lookup.get(x.employeeId)?.allowed_branches?.[0]===p.branchId?0:1;const py=lookup.get(y.employeeId)?.allowed_branches?.[0]===p.branchId?0:1;return px-py||(assigned.get(x.employeeId)!-assigned.get(y.employeeId)!)||x.employeeId.localeCompare(y.employeeId)});
    for(const worker of ranked){
     if(!needed)break;
     if(worker.daysOff.has(i+1))continue;
     const info=lookup.get(worker.employeeId);
     if(info?.allowed_branches?.length&&!info.allowed_branches.includes(p.branchId))continue;
     if((assigned.get(worker.employeeId)||0)*hours+hours>worker.cap)continue;
     const conflict=await checkAssignment(c,a.companyId,worker.employeeId,p.branchId,start,end);
     if(conflict)continue;
     if(await checkHours(c,a.companyId,worker.employeeId,start,hours))continue;
     await c.query('insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,break_minutes,published) values($1,$2,$3,$4,$5,$6,false)',[a.companyId,worker.employeeId,p.branchId,start,end,p.breakMinutes]);
     assigned.set(worker.employeeId,(assigned.get(worker.employeeId)||0)+1);created++;needed--;
    }
    if(needed)unmet.push({day,needed,reason:'INSUFFICIENT_ELIGIBLE_STAFF'});
   }
   await audit(c,a,'GENERATE_BALANCED_DRAFT_SCHEDULE','BRANCH',p.branchId);
   return{ok:true,created,existing,unmet,allocations:[...assigned].map(([employeeId,shifts])=>({employeeId,shifts}))};
  });
 });
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
   for(const row of candidates.rows){const start=new Date(row.startsAt),end=new Date(row.endsAt);const prior=await c.query('select id from shifts where pattern_id=$1 and (starts_at at time zone (select timezone from branches where id=$3))::date=($2::timestamptz at time zone (select timezone from branches where id=$3))::date',[row.patternId,start,row.branchId]);if(prior.rowCount){existing++;continue}let reason=start.getTime()<Date.now()?'SHIFT_IN_PAST':await checkAssignment(c,a.companyId,row.employeeId,row.branchId,start,end);const unavailable=reason==='EMPLOYEE_UNAVAILABLE';if(unavailable)reason='';if(!reason)reason=await checkHours(c,a.companyId,row.employeeId,start,netShiftHours(start,end,row.breakMinutes));if(netShiftHours(start,end,row.breakMinutes)<=0)reason='BREAK_EXCEEDS_SHIFT';if(reason){conflicts.push({...row,reason});continue}await c.query('insert into shifts(company_id,employee_id,branch_id,starts_at,ends_at,break_minutes,pattern_id,published) values($1,$2,$3,$4,$5,$6,$7,false)',[a.companyId,row.employeeId,row.branchId,start,end,row.breakMinutes,row.patternId]);created++;if(unavailable)needsCover.push(row)}
   await audit(c,a,'GENERATE_DRAFT_SCHEDULE','COMPANY',a.companyId);return{ok:true,created,existing,conflicts,needsCover};
  });
 });
 route('PUT','/v1/admin/scheduling/shifts/:shiftId/draft',async(req,a)=>{
  const shift=id(req,'shiftId');
  const p=z.object({employeeId:z.uuid(),branchId:z.uuid(),date:z.iso.date(),...times}).refine(validTimes,'Break must be shorter than the shift; start and end must differ').parse(req.body);
  return tx(async c=>{
   const found=await c.query('select * from shifts where id=$1 and company_id=$2',[shift,a.companyId]);
   if(!found.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);
   const original=found.rows[0];
   if(original.published)throw new ScheduleError('DRAFT_NOT_FOUND');
   await lockEmployees(c,a.companyId,[original.employee_id,p.employeeId]);
   const locked=await c.query('select * from shifts where id=$1 and company_id=$2 for update',[shift,a.companyId]);
   if(!locked.rowCount||locked.rows[0].published||locked.rows[0].employee_id!==original.employee_id)throw new ScheduleError('SCHEDULE_CHANGED_RETRY');
   const attendance=await c.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);
   if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');
   const b=await c.query(`select ($3::date+$4::time) at time zone timezone as start,($3::date+case when $5::time<=$4::time then 1 else 0 end+$5::time) at time zone timezone as "end" from branches where id=$1 and company_id=$2 and active=true`,[p.branchId,a.companyId,p.date,p.startTime,p.endTime]);
   if(!b.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);
   const start=new Date(b.rows[0].start),end=new Date(b.rows[0].end);
   if(start.getTime()<Date.now())throw new ScheduleError('SHIFT_IN_PAST');
   const conflict=await checkAssignment(c,a.companyId,p.employeeId,p.branchId,start,end,shift);
   if(conflict&&conflict!=='EMPLOYEE_UNAVAILABLE')throw new ScheduleError(conflict);
   const weekly=await c.query(`select coalesce(p.max_weekly_hours,40)::float as "limit",coalesce(sum(greatest(0,extract(epoch from(x.ends_at-x.starts_at))/3600-x.break_minutes/60.0)),0)::float as hours from companies co left join employee_schedule_profiles p on p.company_id=co.id and p.employee_id=$2 left join shifts x on x.company_id=co.id and x.employee_id=$2 and x.id<>$4 and x.starts_at>=date_trunc('week',$3::timestamptz at time zone co.timezone) at time zone co.timezone and x.starts_at<(date_trunc('week',$3::timestamptz at time zone co.timezone)+interval '7 days') at time zone co.timezone where co.id=$1 group by p.max_weekly_hours`,[a.companyId,p.employeeId,start,shift]);
   if(Number(weekly.rows[0].hours)+netShiftHours(start,end,p.breakMinutes)>Number(weekly.rows[0].limit))throw new ScheduleError('WEEKLY_HOURS_EXCEEDED');
   await c.query('update shifts set employee_id=$1,branch_id=$2,starts_at=$3,ends_at=$4,break_minutes=$5 where id=$6 and company_id=$7',[p.employeeId,p.branchId,start,end,p.breakMinutes,shift,a.companyId]);
   await audit(c,a,'EDIT_DRAFT_SHIFT','SHIFT',shift);
   return{ok:true};
  });
 });
 route('PUT','/v1/admin/scheduling/shifts/:shiftId/change',async(req,a)=>{
  const shift=id(req,'shiftId');
  const p=z.object({employeeId:z.uuid(),branchId:z.uuid(),date:z.iso.date(),...times}).refine(validTimes,'Break must be shorter than the shift; start and end must differ').parse(req.body);
  return tx(async c=>{
   const found=await c.query('select * from shifts where id=$1 and company_id=$2',[shift,a.companyId]);
   if(!found.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);
   const original=found.rows[0];
   if(new Date(original.starts_at).getTime()<=Date.now())throw new ScheduleError('SHIFT_IN_PAST');
   await lockEmployees(c,a.companyId,[original.employee_id,p.employeeId]);
   const locked=await c.query('select * from shifts where id=$1 and company_id=$2 for update',[shift,a.companyId]);
   if(!locked.rowCount||locked.rows[0].employee_id!==original.employee_id||locked.rows[0].starts_at.getTime()!==original.starts_at.getTime())throw new ScheduleError('SCHEDULE_CHANGED_RETRY');
   const attendance=await c.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);
   if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');
   const b=await c.query(`select ($3::date+$4::time) at time zone timezone as start,($3::date+case when $5::time<=$4::time then 1 else 0 end+$5::time) at time zone timezone as "end" from branches where id=$1 and company_id=$2 and active=true`,[p.branchId,a.companyId,p.date,p.startTime,p.endTime]);
   if(!b.rowCount)throw new ScheduleError('BRANCH_NOT_FOUND',404);
   const start=new Date(b.rows[0].start),end=new Date(b.rows[0].end);
   if(start.getTime()<Date.now())throw new ScheduleError('SHIFT_IN_PAST');
   const conflict=await checkAssignment(c,a.companyId,p.employeeId,p.branchId,start,end,shift);
   if(conflict&&conflict!=='EMPLOYEE_UNAVAILABLE')throw new ScheduleError(conflict);
   const weekly=await c.query(`select coalesce(p.max_weekly_hours,40)::float as "limit",coalesce(sum(greatest(0,extract(epoch from(x.ends_at-x.starts_at))/3600-x.break_minutes/60.0)),0)::float as hours from companies co left join employee_schedule_profiles p on p.company_id=co.id and p.employee_id=$2 left join shifts x on x.company_id=co.id and x.employee_id=$2 and x.id<>$4 and x.starts_at>=date_trunc('week',$3::timestamptz at time zone co.timezone) at time zone co.timezone and x.starts_at<(date_trunc('week',$3::timestamptz at time zone co.timezone)+interval '7 days') at time zone co.timezone where co.id=$1 group by p.max_weekly_hours`,[a.companyId,p.employeeId,start,shift]);
   if(Number(weekly.rows[0].hours)+netShiftHours(start,end,p.breakMinutes)>Number(weekly.rows[0].limit))throw new ScheduleError('WEEKLY_HOURS_EXCEEDED');
   await c.query('update shifts set employee_id=$1,branch_id=$2,starts_at=$3,ends_at=$4,break_minutes=$5 where id=$6 and company_id=$7',[p.employeeId,p.branchId,start,end,p.breakMinutes,shift,a.companyId]);
   if(original.published){await notice(c,a.companyId,original.employee_id,'Your manager changed a published shift. Check your schedule.');if(original.employee_id!==p.employeeId)await notice(c,a.companyId,p.employeeId,'Your manager assigned you a shift. Check your schedule.')}
   await audit(c,a,'CHANGE_SHIFT','SHIFT',shift);return{ok:true};
  });
 });
 route('DELETE','/v1/admin/scheduling/shifts/:shiftId/remove',async(req,a)=>tx(async c=>{
  const shift=id(req,'shiftId');
  const found=await c.query('select * from shifts where id=$1 and company_id=$2 for update',[shift,a.companyId]);
  if(!found.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);
  const original=found.rows[0];
  if(new Date(original.starts_at).getTime()<=Date.now())throw new ScheduleError('SHIFT_IN_PAST');
  const attendance=await c.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);
  if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');
  await c.query('delete from shifts where id=$1 and company_id=$2',[shift,a.companyId]);
  if(original.published)await notice(c,a.companyId,original.employee_id,'Your manager removed a future shift. Check your schedule.');
  await audit(c,a,'REMOVE_FUTURE_SHIFT','SHIFT',shift);
  return{ok:true};
 }));
 route('POST','/v1/admin/scheduling/undo-week-drafts',async(req,a)=>{
  const p=z.object({from:z.iso.date(),branchId:z.uuid().optional()}).parse(req.body);
  const start=new Date(p.from+'T00:00:00Z');
  if(Number.isNaN(start.getTime())||start.getUTCDay()!==1)throw new ScheduleError('WEEK_MUST_START_MONDAY',400);
  const to=new Date(start.getTime()+7*86400000).toISOString().slice(0,10);
  return tx(async c=>{
   const found=await c.query(`select s.id,s.employee_id from shifts s join branches b on b.id=s.branch_id
    where s.company_id=$1 and s.published=false and (s.starts_at at time zone b.timezone)::date >= $2::date
    and (s.starts_at at time zone b.timezone)::date < $3::date
    and ($4::uuid is null or s.branch_id=$4::uuid)
    and not exists(select 1 from attendance_events ae where ae.shift_id=s.id)
    order by s.id for update of s`,[a.companyId,p.from,to,p.branchId??null]);
   if(found.rowCount){
    await c.query('delete from shifts where company_id=$1 and id=ANY($2::uuid[]) and published=false',[a.companyId,found.rows.map(x=>x.id)]);
   }
   await audit(c,a,'UNDO_WEEK_DRAFTS','COMPANY',a.companyId);
   return{ok:true,deleted:found.rowCount??0};
  });
 });
 route('POST','/v1/admin/scheduling/publish',async(req,a)=>{
  const p=z.object({shiftIds:ids}).parse(req.body);return tx(async c=>{const r=await c.query('select id,employee_id,starts_at,ends_at from shifts where company_id=$1 and id=ANY($2::uuid[]) and published=false order by id',[a.companyId,[...new Set(p.shiftIds)]]);if(r.rowCount!==new Set(p.shiftIds).size)throw new ScheduleError('DRAFT_NOT_FOUND');await lockEmployees(c,a.companyId,r.rows.map(r=>r.employee_id));const locked=await c.query('select id,employee_id,starts_at from shifts where company_id=$1 and id=ANY($2::uuid[]) and published=false order by id for update',[a.companyId,[...new Set(p.shiftIds)]]);if(locked.rowCount!==r.rowCount||locked.rows.some(s=>!r.rows.some(x=>x.id===s.id&&x.employee_id===s.employee_id)))throw new ScheduleError('SCHEDULE_CHANGED_RETRY');for(const s of locked.rows){if(new Date(s.starts_at).getTime()<Date.now())throw new ScheduleError('SHIFT_IN_PAST');await c.query('update shifts set published=true where id=$1 and company_id=$2',[s.id,a.companyId])}for(const employee of new Set<string>(r.rows.map(r=>r.employee_id)))await notice(c,a.companyId,employee,'Your manager published new shifts. Check your schedule.');await audit(c,a,'PUBLISH_SCHEDULE','COMPANY',a.companyId);return{ok:true,published:r.rowCount}});
 });
 route('GET','/v1/admin/scheduling/unavailability',async(req,a)=>{const p=rangeSchema.parse(req.query);const r=await db.query(`select u.id,u.employee_id as "employeeId",concat(e.first_name,' ',e.last_name) as "employeeName",u.starts_at as "startsAt",u.ends_at as "endsAt",u.category from employee_unavailability u join employees e on e.id=u.employee_id join companies co on co.id=u.company_id where u.company_id=$1 and u.active=true and u.starts_at<($3::date+1)::timestamp at time zone co.timezone and u.ends_at>$2::date::timestamp at time zone co.timezone order by u.starts_at`,[a.companyId,p.from,p.to]);return{ok:true,unavailability:r.rows}});
 route('POST','/v1/admin/scheduling/unavailability',async(req,a)=>{
  const p=z.object({employeeId:z.uuid(),fromDate:z.iso.date(),toDate:z.iso.date(),category:z.enum(['ABSENCE','INJURY','LEAVE','DAY_OFF'])}).refine(v=>validDateRange(v.fromDate,v.toDate,367)).parse(req.body);
  return tx(async c=>{await lockEmployees(c,a.companyId,[p.employeeId]);const r=await c.query('insert into employee_unavailability(company_id,employee_id,starts_at,ends_at,category) select $1,$2,$3::date::timestamp at time zone timezone,($4::date+1)::timestamp at time zone timezone,$5 from companies where id=$1 returning id',[a.companyId,p.employeeId,p.fromDate,p.toDate,p.category]);await notice(c,a.companyId,p.employeeId,'Your manager updated your availability. Check your schedule.');await audit(c,a,'RECORD_UNAVAILABILITY','EMPLOYEE',p.employeeId);return{ok:true,id:r.rows[0].id}});
 });
 route('DELETE','/v1/admin/scheduling/unavailability/:absenceId',async(req,a)=>tx(async c=>{const absence=id(req,'absenceId');const current=await c.query('select employee_id from employee_unavailability where id=$1 and company_id=$2',[absence,a.companyId]);if(!current.rowCount)throw new ScheduleError('UNAVAILABILITY_NOT_FOUND',404);await lockEmployees(c,a.companyId,[current.rows[0].employee_id]);await c.query('update employee_unavailability set active=false where id=$1 and company_id=$2',[absence,a.companyId]);await notice(c,a.companyId,current.rows[0].employee_id,'Your manager removed an availability exception. Check your schedule.');await audit(c,a,'REMOVE_UNAVAILABILITY','EMPLOYEE',current.rows[0].employee_id);return{ok:true}}));
 const coverOptions=async(c:Pick<Pool,'query'>,company:string,shift:any)=>{
  const r=await c.query(`select e.id as "employeeId",concat(e.first_name,' ',e.last_name) as name,coalesce(p.job_role,'') as "jobRole",coalesce(p.max_weekly_hours,40)::float as "maxWeeklyHours",coalesce(p.allowed_branch_ids,'{}'::uuid[]) as "allowedBranches",
   exists(select 1 from employee_unavailability u where u.company_id=$1 and u.employee_id=e.id and u.active=true and u.starts_at<$4 and u.ends_at>$3) as unavailable,
   exists(select 1 from shifts x where x.company_id=$1 and x.employee_id=e.id and x.id<>$5 and x.starts_at<$4 and x.ends_at>$3) as overlap,
   coalesce((select sum(greatest(0,extract(epoch from(x.ends_at-x.starts_at))/3600-x.break_minutes/60.0)) from shifts x where x.company_id=$1 and x.employee_id=e.id and x.id<>$5 and x.starts_at>=date_trunc('week',$3::timestamptz at time zone co.timezone) at time zone co.timezone and x.starts_at<(date_trunc('week',$3::timestamptz at time zone co.timezone)+interval '7 days') at time zone co.timezone),0)::float as "scheduledHours"
   from employees e join companies co on co.id=e.company_id left join employee_schedule_profiles p on p.employee_id=e.id and p.company_id=e.company_id where e.company_id=$1 and e.active=true and e.id<>$2 order by "scheduledHours",e.first_name`,[company,shift.employee_id,shift.starts_at,shift.ends_at,shift.id]);
  const profile=await c.query('select job_role from employee_schedule_profiles where company_id=$1 and employee_id=$2',[company,shift.employee_id]);const requiredRole=profile.rows[0]?.job_role||'';const hours=netShiftHours(shift.starts_at,shift.ends_at,shift.break_minutes);return{requiredRole,candidates:r.rows.filter(row=>eligibleCover(row,shift.branch_id,requiredRole,hours)),hours};
 };
 route('GET','/v1/admin/scheduling/shifts/:shiftId/cover',async(req,a)=>{const shift=id(req,'shiftId');const r=await db.query('select * from shifts where id=$1 and company_id=$2',[shift,a.companyId]);if(!r.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);const attendance=await db.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');return{ok:true,...await coverOptions(db,a.companyId,r.rows[0])}});
 route('POST','/v1/admin/scheduling/shifts/:shiftId/cover',async(req,a)=>{
  const shift=id(req,'shiftId'),p=z.object({employeeId:z.uuid()}).parse(req.body);return tx(async c=>{const r=await c.query('select * from shifts where id=$1 and company_id=$2',[shift,a.companyId]);if(!r.rowCount)throw new ScheduleError('SHIFT_NOT_FOUND',404);const original=r.rows[0];if(new Date(original.ends_at).getTime()<=Date.now())throw new ScheduleError('SHIFT_IN_PAST');await lockEmployees(c,a.companyId,[original.employee_id,p.employeeId]);const locked=await c.query('select * from shifts where id=$1 and company_id=$2 for update',[shift,a.companyId]);if(!locked.rowCount||locked.rows[0].employee_id!==original.employee_id)throw new ScheduleError('SCHEDULE_CHANGED_RETRY');Object.assign(original,locked.rows[0]);const attendance=await c.query('select 1 from attendance_events where shift_id=$1 limit 1',[shift]);if(attendance.rowCount)throw new ScheduleError('SHIFT_HAS_ATTENDANCE');const options=await coverOptions(c,a.companyId,original);if(!options.candidates.some(row=>row.employeeId===p.employeeId))throw new ScheduleError('COVER_NO_LONGER_AVAILABLE');await c.query('update shifts set employee_id=$1 where id=$2 and company_id=$3',[p.employeeId,shift,a.companyId]);if(original.published){await notice(c,a.companyId,original.employee_id,'A shift was reassigned by your manager. Check your updated schedule.');await notice(c,a.companyId,p.employeeId,'Your manager assigned you a replacement shift. Check your updated schedule.')}await audit(c,a,'ASSIGN_SHIFT_COVER','SHIFT',shift);return{ok:true}});
 });
 app.get('/v1/employee/schedule',async(req,reply)=>{
  reply.header('Cache-Control','no-store');const a=await authenticateEmployee(db,req.headers.authorization);if(!a)return reply.code(401).send({ok:false,error:'EMPLOYEE_AUTH_REQUIRED'});
  const parsed=rangeSchema.safeParse(req.query);if(!parsed.success)return reply.code(400).send({ok:false,error:'INVALID_DATE_RANGE'});const p=parsed.data;
  const [shifts,unavailable,notices]=await Promise.all([db.query(`select s.id,b.name as "branchName",s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes",(select min(occurred_at) from attendance_events where shift_id=s.id and employee_id=$2 and action='CHECK_IN') as "checkInAt",(select max(occurred_at) from attendance_events where shift_id=s.id and employee_id=$2 and action='CHECK_OUT') as "checkOutAt" from shifts s join branches b on b.id=s.branch_id join companies co on co.id=s.company_id where s.company_id=$1 and s.employee_id=$2 and s.published=true and s.starts_at<($4::date+1)::timestamp at time zone co.timezone and s.ends_at>$3::date::timestamp at time zone co.timezone order by s.starts_at`,[a.companyId,a.employeeId,p.from,p.to]),db.query(`select u.starts_at as "startsAt",u.ends_at as "endsAt" from employee_unavailability u join companies co on co.id=u.company_id where u.company_id=$1 and u.employee_id=$2 and u.active=true and u.starts_at<($4::date+1)::timestamp at time zone co.timezone and u.ends_at>$3::date::timestamp at time zone co.timezone order by u.starts_at`,[a.companyId,a.employeeId,p.from,p.to]),db.query(`select id,message,created_at as "createdAt" from schedule_notices where company_id=$1 and employee_id=$2 order by created_at desc limit 10`,[a.companyId,a.employeeId])]);return{ok:true,shifts:shifts.rows,unavailability:unavailable.rows,notices:notices.rows};
 });
}
