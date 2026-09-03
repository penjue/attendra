import { z } from 'zod';
import { db } from './db.js';

const periodSchema=z.object({from:z.iso.datetime(),to:z.iso.datetime()});
const validPeriod=(from:string,to:string)=>{const a=new Date(from).getTime(),b=new Date(to).getTime();return b>a&&b-a<=1000*60*60*24*366};
const alertSettingsSchema=z.object({
  lateAfterMinutes:z.number().int().min(0).max(180),
  missedShiftAfterMinutes:z.number().int().min(1).max(180),
  missingCheckoutAfterMinutes:z.number().int().min(1).max(240),
  tabletOfflineAfterMinutes:z.number().int().min(1).max(60),
  notifyHighPriority:z.boolean(),
  notifyMediumPriority:z.boolean()
});
const defaultAlertSettings={lateAfterMinutes:5,missedShiftAfterMinutes:10,missingCheckoutAfterMinutes:15,tabletOfflineAfterMinutes:3,notifyHighPriority:true,notifyMediumPriority:false};

type RequireAdmin=(request:any,reply:any)=>{email:string;companyId:string;exp:number}|null;

export const registerTimesheetRoutes=(app:any,requireAdmin:RequireAdmin)=>{
  app.get('/v1/admin/alert-settings',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;
    const r=await db.query(`select late_after_minutes as "lateAfterMinutes",missed_shift_after_minutes as "missedShiftAfterMinutes",missing_checkout_after_minutes as "missingCheckoutAfterMinutes",tablet_offline_after_minutes as "tabletOfflineAfterMinutes",notify_high_priority as "notifyHighPriority",notify_medium_priority as "notifyMediumPriority",updated_by as "updatedBy",updated_at as "updatedAt" from company_alert_settings where company_id=$1 limit 1`,[a.companyId]);
    return{ok:true,settings:r.rows[0]??defaultAlertSettings};
  });

  app.put('/v1/admin/alert-settings',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;
    const p=alertSettingsSchema.safeParse(request.body);if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_ALERT_SETTINGS',details:p.error.flatten()});
    const s=p.data;
    const r=await db.query(`insert into company_alert_settings(company_id,late_after_minutes,missed_shift_after_minutes,missing_checkout_after_minutes,tablet_offline_after_minutes,notify_high_priority,notify_medium_priority,updated_by) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(company_id) do update set late_after_minutes=excluded.late_after_minutes,missed_shift_after_minutes=excluded.missed_shift_after_minutes,missing_checkout_after_minutes=excluded.missing_checkout_after_minutes,tablet_offline_after_minutes=excluded.tablet_offline_after_minutes,notify_high_priority=excluded.notify_high_priority,notify_medium_priority=excluded.notify_medium_priority,updated_by=excluded.updated_by,updated_at=now() returning late_after_minutes as "lateAfterMinutes",missed_shift_after_minutes as "missedShiftAfterMinutes",missing_checkout_after_minutes as "missingCheckoutAfterMinutes",tablet_offline_after_minutes as "tabletOfflineAfterMinutes",notify_high_priority as "notifyHighPriority",notify_medium_priority as "notifyMediumPriority",updated_by as "updatedBy",updated_at as "updatedAt"`,[a.companyId,s.lateAfterMinutes,s.missedShiftAfterMinutes,s.missingCheckoutAfterMinutes,s.tabletOfflineAfterMinutes,s.notifyHighPriority,s.notifyMediumPriority,a.email]);
    await db.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata) values($1,'ADMIN',$2,'UPDATE_ALERT_SETTINGS','COMPANY_ALERT_SETTINGS',$1::text,$3::jsonb)`,[a.companyId,a.email,JSON.stringify(s)]);
    return{ok:true,settings:r.rows[0]};
  });

  app.post('/v1/devices/heartbeat',async(request:any,reply:any)=>{
    const p=z.object({companyId:z.uuid(),branchId:z.uuid(),deviceId:z.uuid()}).safeParse(request.body);
    if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_HEARTBEAT'});
    const r=await db.query(`update devices set last_seen_at=now() where id=$1 and company_id=$2 and branch_id=$3 and active=true returning id,last_seen_at as "lastSeenAt"`,[p.data.deviceId,p.data.companyId,p.data.branchId]);
    if(!r.rowCount)return reply.code(403).send({ok:false,error:'DEVICE_NOT_AUTHORISED'});
    return{ok:true,device:r.rows[0]};
  });

  app.post('/v1/attendance/eligibility',async(request:any,reply:any)=>{
    const p=z.object({companyId:z.uuid(),branchId:z.uuid(),employeeNumber:z.string().trim().min(1).max(64),pin:z.string().regex(/^\d{4,12}$/),occurredAt:z.iso.datetime(),action:z.enum(['CHECK_IN','CHECK_OUT'])}).safeParse(request.body);
    if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_REQUEST'});
    const employee=await db.query(`select id from employees where company_id=$1 and employee_number=$2 and active=true and pin_hash=crypt($3,pin_hash) limit 1`,[p.data.companyId,p.data.employeeNumber,p.data.pin]);
    if(!employee.rowCount)return reply.code(401).send({ok:false,error:'INVALID_EMPLOYEE_OR_PIN'});
    const shift=await db.query(`select id,starts_at as "startsAt",ends_at as "endsAt" from shifts where company_id=$1 and branch_id=$2 and employee_id=$3 and $4::timestamptz between starts_at-interval '4 hours' and ends_at+interval '4 hours' order by abs(extract(epoch from(starts_at-$4::timestamptz))) limit 1`,[p.data.companyId,p.data.branchId,employee.rows[0].id,p.data.occurredAt]);
    if(!shift.rowCount)return reply.code(409).send({ok:false,error:'NO_SCHEDULED_SHIFT'});
    return{ok:true,shift:shift.rows[0]};
  });

  app.get('/v1/admin/timesheets',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;
    const p=periodSchema.safeParse(request.query);if(!p.success||!validPeriod(p.success?p.data.from:'',p.success?p.data.to:''))return reply.code(400).send({ok:false,error:'INVALID_REPORT_PERIOD'});
    const fromMs=new Date(p.data.from).getTime(),toMs=new Date(p.data.to).getTime(),now=Date.now();
    const lookback=new Date(fromMs-24*60*60*1000).toISOString();
    const lookahead=new Date(toMs+24*60*60*1000).toISOString();
    const [shiftsResult,eventsResult]=await Promise.all([
      db.query(`select s.id,s.employee_id as "employeeId",e.employee_number as "employeeNumber",concat(e.first_name,' ',e.last_name) as "employeeName",s.branch_id as "branchId",b.name as "branchName",s.starts_at as "startsAt",s.ends_at as "endsAt",s.break_minutes as "breakMinutes" from shifts s join employees e on e.id=s.employee_id join branches b on b.id=s.branch_id where s.company_id=$1 and s.starts_at<$3::timestamptz and s.ends_at>$2::timestamptz order by e.first_name,e.last_name,s.starts_at`,[a.companyId,p.data.from,p.data.to]),
      db.query(`select ae.id,ae.employee_id as "employeeId",e.employee_number as "employeeNumber",concat(e.first_name,' ',e.last_name) as "employeeName",ae.branch_id as "branchId",b.name as "branchName",ae.shift_id as "shiftId",ae.action,ae.status,ae.occurred_at as "occurredAt",ae.source from attendance_events ae join employees e on e.id=ae.employee_id join branches b on b.id=ae.branch_id where ae.company_id=$1 and ae.occurred_at>=$2::timestamptz and ae.occurred_at<$3::timestamptz order by ae.employee_id,ae.occurred_at`,[a.companyId,lookback,lookahead])
    ]);
    const byShift=new Map<string,any[]>();
    const unscheduledByEmployee=new Map<string,any[]>();
    for(const event of eventsResult.rows){
      if(event.shiftId){const list=byShift.get(event.shiftId)??[];list.push(event);byShift.set(event.shiftId,list)}
      else if(new Date(event.occurredAt).getTime()>=fromMs&&new Date(event.occurredAt).getTime()<toMs){const list=unscheduledByEmployee.get(event.employeeId)??[];list.push(event);unscheduledByEmployee.set(event.employeeId,list)}
    }
    const entries:any[]=[];
    for(const shift of shiftsResult.rows){
      const startMs=new Date(shift.startsAt).getTime(),endMs=new Date(shift.endsAt).getTime();
      const events=(byShift.get(shift.id)??[]).filter(e=>{const t=new Date(e.occurredAt).getTime();return t>=startMs-4*60*60*1000&&t<=endMs+4*60*60*1000});
      const checkIn=events.find(e=>e.action==='CHECK_IN')??null;
      const checkInMs=checkIn?new Date(checkIn.occurredAt).getTime():null;
      const checkOut=checkIn?events.find(e=>e.action==='CHECK_OUT'&&new Date(e.occurredAt).getTime()>=checkInMs!):null;
      const checkOutMs=checkOut?new Date(checkOut.occurredAt).getTime():null;
      const scheduledMinutes=Math.max(0,Math.round((endMs-startMs)/60000)-Number(shift.breakMinutes??0));
      const grossEnd=checkOutMs??(checkInMs!==null?Math.min(now,toMs):null);
      const grossMinutes=checkInMs!==null&&grossEnd!==null&&grossEnd>checkInMs?Math.round((grossEnd-checkInMs)/60000):0;
      const workedMinutes=Math.max(0,grossMinutes-(grossMinutes>0?Number(shift.breakMinutes??0):0));
      const status=!checkIn?(endMs<=Math.min(now,toMs)?'MISSED':'UPCOMING'):!checkOut?'OPEN':'COMPLETE';
      entries.push({entryId:`shift:${shift.id}`,shiftId:shift.id,employeeId:shift.employeeId,employeeNumber:shift.employeeNumber,employeeName:shift.employeeName,branchId:shift.branchId,branchName:shift.branchName,date:new Date(shift.startsAt).toISOString().slice(0,10),scheduledStart:shift.startsAt,scheduledEnd:shift.endsAt,breakMinutes:Number(shift.breakMinutes??0),checkInAt:checkIn?.occurredAt??null,checkOutAt:checkOut?.occurredAt??null,workedMinutes,scheduledMinutes,overtimeMinutes:Math.max(0,workedMinutes-scheduledMinutes),lateMinutes:checkInMs===null?0:Math.max(0,Math.round((checkInMs-startMs-5*60000)/60000)),earlyLeaveMinutes:checkOutMs===null?0:Math.max(0,Math.round((endMs-checkOutMs)/60000)),status,needsReview:status==='OPEN'||status==='MISSED'});
    }
    for(const [employeeId,list] of unscheduledByEmployee){
      let open:any=null;
      for(const event of list){
        if(event.action==='CHECK_IN'){if(open){entries.push({entryId:`unscheduled:${open.id}`,shiftId:null,employeeId,employeeNumber:open.employeeNumber,employeeName:open.employeeName,branchId:open.branchId,branchName:open.branchName,date:new Date(open.occurredAt).toISOString().slice(0,10),scheduledStart:null,scheduledEnd:null,breakMinutes:0,checkInAt:open.occurredAt,checkOutAt:null,workedMinutes:0,scheduledMinutes:0,overtimeMinutes:0,lateMinutes:0,earlyLeaveMinutes:0,status:'OPEN',needsReview:true})}open=event}
        else if(open){const start=new Date(open.occurredAt).getTime(),end=new Date(event.occurredAt).getTime();const worked=Math.max(0,Math.round((end-start)/60000));entries.push({entryId:`unscheduled:${open.id}`,shiftId:null,employeeId,employeeNumber:open.employeeNumber,employeeName:open.employeeName,branchId:open.branchId,branchName:open.branchName,date:new Date(open.occurredAt).toISOString().slice(0,10),scheduledStart:null,scheduledEnd:null,breakMinutes:0,checkInAt:open.occurredAt,checkOutAt:event.occurredAt,workedMinutes:worked,scheduledMinutes:0,overtimeMinutes:worked,lateMinutes:0,earlyLeaveMinutes:0,status:'UNSCHEDULED',needsReview:true});open=null}
      }
      if(open){entries.push({entryId:`unscheduled:${open.id}`,shiftId:null,employeeId,employeeNumber:open.employeeNumber,employeeName:open.employeeName,branchId:open.branchId,branchName:open.branchName,date:new Date(open.occurredAt).toISOString().slice(0,10),scheduledStart:null,scheduledEnd:null,breakMinutes:0,checkInAt:open.occurredAt,checkOutAt:null,workedMinutes:Math.max(0,Math.round((Math.min(now,toMs)-new Date(open.occurredAt).getTime())/60000)),scheduledMinutes:0,overtimeMinutes:0,lateMinutes:0,earlyLeaveMinutes:0,status:'OPEN',needsReview:true})}
    }
    entries.sort((x,y)=>x.employeeName.localeCompare(y.employeeName)||new Date(x.scheduledStart??x.checkInAt).getTime()-new Date(y.scheduledStart??y.checkInAt).getTime());
    return{ok:true,period:{from:p.data.from,to:p.data.to},entries};
  });

  app.post('/v1/admin/timekeeping/corrections',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;
    const p=z.object({employeeId:z.uuid(),branchId:z.uuid(),shiftId:z.uuid().nullable().optional(),occurredAt:z.iso.datetime(),reason:z.string().trim().min(3).max(300)}).safeParse(request.body);
    if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_CORRECTION'});
    const [employee,branch]=await Promise.all([db.query(`select id from employees where id=$1 and company_id=$2`,[p.data.employeeId,a.companyId]),db.query(`select id from branches where id=$1 and company_id=$2`,[p.data.branchId,a.companyId])]);
    if(!employee.rowCount)return reply.code(404).send({ok:false,error:'EMPLOYEE_NOT_FOUND'});if(!branch.rowCount)return reply.code(404).send({ok:false,error:'BRANCH_NOT_FOUND'});
    if(p.data.shiftId){const shift=await db.query(`select id from shifts where id=$1 and company_id=$2 and employee_id=$3`,[p.data.shiftId,a.companyId,p.data.employeeId]);if(!shift.rowCount)return reply.code(404).send({ok:false,error:'SHIFT_NOT_FOUND'})}
    const at=new Date(p.data.occurredAt);
    const prior=await db.query(`select action,occurred_at,device_id,branch_id,shift_id from attendance_events where company_id=$1 and employee_id=$2 and occurred_at<=$3::timestamptz order by occurred_at desc limit 1`,[a.companyId,p.data.employeeId,at.toISOString()]);
    if(!prior.rowCount||prior.rows[0].action!=='CHECK_IN')return reply.code(409).send({ok:false,error:'NO_OPEN_SESSION'});
    const priorEvent=prior.rows[0];
    const correctionDeviceId=priorEvent.device_id;
    if(!correctionDeviceId)return reply.code(409).send({ok:false,error:'CORRECTION_DEVICE_MISSING'});
    const correctionBranchId=p.data.branchId||priorEvent.branch_id;
    const correctionShiftId=p.data.shiftId??priorEvent.shift_id??null;
    const c=await db.connect();try{await c.query('BEGIN');const r=await c.query(`insert into attendance_events(company_id,branch_id,device_id,employee_id,shift_id,action,status,occurred_at,source) values($1,$2,$3,$4,$5,'CHECK_OUT','ON_TIME',$6,'ADMIN') returning id,occurred_at as "occurredAt"`,[a.companyId,correctionBranchId,correctionDeviceId,p.data.employeeId,correctionShiftId,at.toISOString()]);await c.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata) values($1,'ADMIN',$2,'ADD_CHECK_OUT','ATTENDANCE_EVENT',$3,jsonb_build_object('employeeId',$4::uuid,'shiftId',$5::text,'reason',$6,'originalDeviceId',$7::text))`,[a.companyId,a.email,r.rows[0].id,p.data.employeeId,correctionShiftId,p.data.reason,correctionDeviceId]);await c.query('COMMIT');return reply.code(201).send({ok:true,event:r.rows[0]})}catch(error){await c.query('ROLLBACK');app.log.error(error);return reply.code(500).send({ok:false,error:'CORRECTION_FAILED'})}finally{c.release()}
  });

  app.delete('/v1/admin/timekeeping/unscheduled/:eventId',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;
    const p=z.object({eventId:z.uuid()}).safeParse(request.params);if(!p.success)return reply.code(400).send({ok:false,error:'INVALID_EVENT_ID'});
    const target=await db.query(`select id,employee_id,action,occurred_at from attendance_events where id=$1 and company_id=$2 and shift_id is null`,[p.data.eventId,a.companyId]);
    if(!target.rowCount)return reply.code(404).send({ok:false,error:'UNSCHEDULED_EVENT_NOT_FOUND'});
    const event=target.rows[0];const ids=[event.id];
    if(event.action==='CHECK_IN'){
      const pair=await db.query(`select id from attendance_events where company_id=$1 and employee_id=$2 and shift_id is null and action='CHECK_OUT' and occurred_at>$3::timestamptz and occurred_at<coalesce((select min(occurred_at) from attendance_events where company_id=$1 and employee_id=$2 and shift_id is null and action='CHECK_IN' and occurred_at>$3::timestamptz),'infinity'::timestamptz) order by occurred_at limit 1`,[a.companyId,event.employee_id,event.occurred_at]);
      if(pair.rowCount)ids.push(pair.rows[0].id);
    }
    const c=await db.connect();try{await c.query('BEGIN');await c.query(`delete from attendance_events where company_id=$1 and id=any($2::uuid[]) and shift_id is null`,[a.companyId,ids]);await c.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata) values($1,'ADMIN',$2,'REMOVE_UNSCHEDULED_ATTENDANCE','ATTENDANCE_EVENT',$3,jsonb_build_object('removedEventIds',$4::text[],'employeeId',$5::uuid))`,[a.companyId,a.email,event.id,ids,event.employee_id]);await c.query('COMMIT');return{ok:true,removed:ids.length}}catch(error){await c.query('ROLLBACK');app.log.error(error);return reply.code(500).send({ok:false,error:'UNSCHEDULED_REMOVE_FAILED'})}finally{c.release()}
  });

  app.get('/v1/admin/pay-period-approval',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;const p=periodSchema.safeParse(request.query);if(!p.success||!validPeriod(p.success?p.data.from:'',p.success?p.data.to:''))return reply.code(400).send({ok:false,error:'INVALID_REPORT_PERIOD'});
    const r=await db.query(`select period_from as "from",period_to as "to",include_overtime as "includeOvertime",approved_by as "approvedBy",approved_at as "approvedAt" from pay_period_approvals where company_id=$1 and period_from=$2::timestamptz and period_to=$3::timestamptz limit 1`,[a.companyId,p.data.from,p.data.to]);return{ok:true,approval:r.rows[0]??null};
  });

  app.post('/v1/admin/pay-period-approval',async(request:any,reply:any)=>{
    const a=requireAdmin(request,reply);if(!a)return;const p=z.object({from:z.iso.datetime(),to:z.iso.datetime(),includeOvertime:z.boolean()}).safeParse(request.body);if(!p.success||!validPeriod(p.success?p.data.from:'',p.success?p.data.to:''))return reply.code(400).send({ok:false,error:'INVALID_REPORT_PERIOD'});
    const open=await db.query(`with ordered as(select employee_id,action,occurred_at,lead(action) over(partition by employee_id order by occurred_at) as next_action from attendance_events where company_id=$1 and occurred_at>=$2::timestamptz and occurred_at<$3::timestamptz) select 1 from ordered where action='CHECK_IN' and next_action is null limit 1`,[a.companyId,p.data.from,p.data.to]);if(open.rowCount)return reply.code(409).send({ok:false,error:'UNRESOLVED_OPEN_SESSION'});
    const r=await db.query(`insert into pay_period_approvals(company_id,period_from,period_to,include_overtime,approved_by) values($1,$2,$3,$4,$5) on conflict(company_id,period_from,period_to) do update set include_overtime=excluded.include_overtime,approved_by=excluded.approved_by,approved_at=now() returning period_from as "from",period_to as "to",include_overtime as "includeOvertime",approved_by as "approvedBy",approved_at as "approvedAt"`,[a.companyId,p.data.from,p.data.to,p.data.includeOvertime,a.email]);await db.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata) values($1,'ADMIN',$2,'APPROVE_PAY_PERIOD','PAY_PERIOD',null,jsonb_build_object('from',$3::text,'to',$4::text,'includeOvertime',$5::boolean))`,[a.companyId,a.email,p.data.from,p.data.to,p.data.includeOvertime]);return reply.code(201).send({ok:true,approval:r.rows[0]});
  });
};