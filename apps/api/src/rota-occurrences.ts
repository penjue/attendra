import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requireAdmin } from './admin-auth.js';

// Explicit manager-triggered generation. No background jobs and no automatic publication.
export function registerRotaOccurrenceRoutes(app:FastifyInstance,db:Pick<Pool,'connect'>){
 app.post('/v1/admin/rota-recurrences/:recurrenceId/generate-next',async(req,reply)=>{
  const admin=requireAdmin(req,reply);if(!admin)return;
  const parsed=z.uuid().safeParse((req.params as {recurrenceId:string}).recurrenceId);
  if(!parsed.success)return reply.code(400).send({ok:false,error:'INVALID_RECURRENCE_ID'});
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   const r=await client.query(`select r.id,r.next_period_start::text as period_start,r.end_mode,r.end_date::text as end_date,
    r.cadence,r.status,t.id as template_id,t.approved_version,t.branch_id,t.timezone
    from rota_recurrences r join rota_templates t on t.id=r.template_id
    where r.id=$1 and t.company_id=$2 and t.status='APPROVED' for update of r`,[parsed.data,admin.companyId]);
   if(!r.rowCount){await client.query('ROLLBACK');return reply.code(404).send({ok:false,error:'RECURRENCE_NOT_FOUND'})}
   const x=r.rows[0];
   if(x.status!=='ACTIVE'){await client.query('ROLLBACK');return reply.code(409).send({ok:false,error:'RECURRENCE_NOT_ACTIVE'})}
   if(x.end_mode==='ON_DATE'&&x.period_start>x.end_date){
    await client.query('UPDATE rota_recurrences SET status=\'STOPPED\',updated_at=now() WHERE id=$1',[x.id]);
    await client.query('COMMIT');return {ok:true,finished:true,created:0};
   }
   const occurrence=await client.query(`insert into rota_occurrences(recurrence_id,period_start,template_version)
    values($1,$2,$3) on conflict(recurrence_id,period_start) do nothing returning id`,[x.id,x.period_start,x.approved_version]);
   if(!occurrence.rowCount){await client.query('ROLLBACK');return reply.code(409).send({ok:false,error:'OCCURRENCE_ALREADY_EXISTS'})}
   const entries=await client.query(`select employee_id,day_offset,start_local_time::text as start_time,end_local_time::text as end_time,
    end_day_offset,break_minutes from rota_template_shifts where template_id=$1 order by day_offset,start_local_time,employee_id`,[x.template_id]);
   const skipped:string[]=[];let created=0;
   for(const s of entries.rows){
    // Month end: do not silently shift a 29th/30th/31st into the next month.
    const bounds=await client.query(`select ($1::date+$2::integer)::date::text as day,
     (($1::date+$2::integer)::date < (case when $3='WEEKLY' then $1::date+7 else ($1::date+interval '1 month')::date end)) as within_period`,
     [x.period_start,s.day_offset,x.cadence]);
    const day=bounds.rows[0].day;
    if(!bounds.rows[0].within_period || (x.end_mode==='ON_DATE'&&day>x.end_date)){skipped.push('DAY_OUTSIDE_PERIOD:'+s.day_offset);continue}
    const time=await client.query(`select (($1::date+$2::time) at time zone $4) as starts,
     (($1::date+$5::integer+$3::time) at time zone $4) as ends`,
     [day,s.start_time,s.end_time,x.timezone,s.end_day_offset]);
    const starts=time.rows[0].starts,ends=time.rows[0].ends;
    if(new Date(starts)>=new Date(ends)){skipped.push('INVALID_TIME:'+s.day_offset);continue}
    const eligible=await client.query(`select e.id from employees e left join employee_schedule_profiles p
     on p.employee_id=e.id and p.company_id=e.company_id
     where e.id=$1 and e.company_id=$2 and e.active=true
     and (p.allowed_branch_ids is null or cardinality(p.allowed_branch_ids)=0 or $3::uuid=any(p.allowed_branch_ids))`,
     [s.employee_id,admin.companyId,x.branch_id]);
    if(!eligible.rowCount){skipped.push('EMPLOYEE_INELIGIBLE:'+s.day_offset);continue}
    const collision=await client.query(`select 1 from shifts where company_id=$1 and employee_id=$2
     and starts_at<$4 and ends_at>$3 limit 1`,[admin.companyId,s.employee_id,starts,ends]);
    const absence=await client.query(`select 1 from employee_unavailability where company_id=$1 and employee_id=$2
     and active=true and starts_at<$4 and ends_at>$3 limit 1`,[admin.companyId,s.employee_id,starts,ends]);
    if(collision.rowCount||absence.rowCount){skipped.push((collision.rowCount?'SHIFT_CONFLICT:':'UNAVAILABLE:')+s.day_offset);continue}
    try{
     // A failed shift validation must not invalidate the entire transaction.
     await client.query('SAVEPOINT shift_attempt');
     await client.query(`insert into shifts(company_id,branch_id,employee_id,starts_at,ends_at,break_minutes,published,rota_occurrence_id)
      values($1,$2,$3,$4,$5,$6,false,$7)`,[admin.companyId,x.branch_id,s.employee_id,starts,ends,s.break_minutes,occurrence.rows[0].id]);
     await client.query('RELEASE SAVEPOINT shift_attempt');created++;
    }catch(e:any){
     await client.query('ROLLBACK TO SAVEPOINT shift_attempt');
     await client.query('RELEASE SAVEPOINT shift_attempt');
     if(e.code!=='P0001')throw e;
     skipped.push('VALIDATION_FAILED:'+s.day_offset);
    }
   }
   const next=await client.query(`select (case when $2='WEEKLY' then $1::date+7 else ($1::date+interval '1 month')::date end)::text as next`,[x.period_start,x.cadence]);
   await client.query('update rota_recurrences set next_period_start=$2,updated_at=now() where id=$1',[x.id,next.rows[0].next]);
   await client.query('COMMIT');
   return {ok:true,occurrenceId:occurrence.rows[0].id,periodStart:x.period_start,created,skipped,requiresManagerApproval:true};
  }catch(e){await client.query('ROLLBACK');req.log.error(e);return reply.code(500).send({ok:false,error:'RECURRENCE_GENERATION_FAILED'})}
  finally{client.release()}
 });
}
