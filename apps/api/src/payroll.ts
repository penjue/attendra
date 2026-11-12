import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
import { requireAdmin } from './admin-auth.js';
import { calculateScheduledPayroll } from './scheduling.js';

const monthSchema=z.string().regex(/^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/);
class PayrollError extends Error { constructor(public code:string,public status=409){super(code)} }
// All source writes wait while approval reads and commits its immutable snapshots.
// A table lock also covers inserts (employee/row locks alone do not prevent phantoms).
const sourceTables=`companies,company_admins,employees,branches,shifts,attendance_events,
 employee_compensation_profiles,employee_compensation_history,employee_schedule_profiles,
 shift_overtime_approvals,payroll_shift_reviews,payroll_draft_adjustments,employee_payroll_snapshots,payroll_runs`;

export async function payrollPreview(c:PoolClient,companyId:string,month:string){
 const company=(await c.query(`select name,timezone,currency,
 date_trunc('month',now() at time zone timezone)>($2||'-01')::date as closed
 from companies where id=$1`,[companyId,month])).rows[0];
 if(!company)throw new PayrollError('COMPANY_NOT_FOUND',404);
 const blockers:string[]=[];
 if(!company.closed)blockers.push('PAYROLL_MONTH_STILL_OPEN');
 const checks=(await c.query(`select
 exists(select 1 from shifts s where s.company_id=$1 and
 s.starts_at<((($2||'-01')::date+interval '1 month') at time zone co.timezone)
 and s.ends_at>(($2||'-01')::date at time zone co.timezone)
 and (not s.published or s.ends_at>now())) as unready,
 exists(select 1 from shifts s where s.company_id=$1 and s.published
 and s.starts_at<((($2||'-01')::date+interval '1 month') at time zone co.timezone)
 and s.ends_at>(($2||'-01')::date at time zone co.timezone)
 and not exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=s.id and pr.employee_id=s.employee_id and pr.decision in ('WORKED','CANCELLED'))
 and (exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=s.id and pr.decision='REASSIGNMENT_REQUIRED')
 or not exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_IN')
 or not exists(select 1 from attendance_events ae where ae.shift_id=s.id and ae.employee_id=s.employee_id and ae.action='CHECK_OUT'))) as exceptions,
 exists(select 1 from employees e where e.company_id=$1 and (e.active or exists(select 1 from shifts s where s.employee_id=e.id and s.company_id=$1 and s.published and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2))
 and not exists(select 1 from employee_compensation_profiles cp where cp.company_id=$1 and cp.employee_id=e.id)) as missing_profiles,
 exists(select 1 from payroll_draft_adjustments d where d.company_id=$1 and d.payroll_month=($2||'-01')::date and d.voided_at is null and d.review_status='PENDING') as pending_adjustments,
 exists(select 1 from employee_payroll_snapshots ps where ps.company_id=$1 and ps.payroll_month=($2||'-01')::date and ps.status='FINALISED') as finalised
 from companies co where co.id=$1`,[companyId,month])).rows[0];
 for(const [key,code] of Object.entries({unready:'UNFINISHED_OR_UNPUBLISHED_SHIFTS',exceptions:'ATTENDANCE_EXCEPTION_REVIEW_REQUIRED',missing_profiles:'COMPENSATION_PROFILE_REQUIRED',pending_adjustments:'PAYROLL_ADJUSTMENT_REVIEW_REQUIRED',finalised:'PAYROLL_ALREADY_APPROVED'}))if(checks[key])blockers.push(code);
 // The current preview intentionally requires one currency/pay type per employee and month.
 // Fail closed on transitions rather than silently mixing money or dropping historical earnings.
 const invalidRates=await c.query(`select 1 from employee_compensation_profiles cp join companies co on co.id=cp.company_id
 left join lateral(select h.* from employee_compensation_history h where h.company_id=cp.company_id and h.employee_id=cp.employee_id
 and h.effective_from<=($2||'-01')::date order by h.effective_from desc limit 1) baseline on true
 where cp.company_id=$1 and (baseline.id is null or baseline.pay_type<>cp.pay_type or baseline.currency<>cp.currency
 or exists(select 1 from employee_compensation_history h where h.company_id=$1 and h.employee_id=cp.employee_id
 and to_char(h.effective_from,'YYYY-MM')=$2 and (h.pay_type<>cp.pay_type or h.currency<>cp.currency))) limit 1`,[companyId,month]);
 if(invalidRates.rowCount)blockers.push('MONTH_START_COMPENSATION_HISTORY_REQUIRED');
 // Validate every overtime approval that will enter this month, including cross-week/currency errors.
 const invalidOt=await c.query(`select 1 from shift_overtime_approvals oa join shifts s on s.id=oa.shift_id and s.company_id=oa.company_id
 join companies co on co.id=s.company_id join employee_compensation_profiles cp on cp.company_id=s.company_id and cp.employee_id=s.employee_id
 where oa.company_id=$1 and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$2
 and not exists(select 1 from payroll_shift_reviews pr where pr.company_id=$1 and pr.shift_id=s.id and pr.decision='CANCELLED')
 and (oa.employee_id<>s.employee_id or oa.currency<>cp.currency or oa.overtime_hours>extract(epoch from(s.ends_at-s.starts_at))/3600
 or oa.week_start<>date_trunc('week',s.starts_at at time zone co.timezone)::date
 or oa.week_start<>date_trunc('week',(s.ends_at-interval '1 microsecond') at time zone co.timezone)::date) limit 1`,[companyId,month]);
 if(invalidOt.rowCount)blockers.push('OVERTIME_APPROVAL_RECONCILIATION_REQUIRED');
 let base:any={employees:[]};
 try{base=await calculateScheduledPayroll(c,{companyId},{month})}catch(error:any){if(error.status===409)blockers.push(error.code);else throw error}
 const adjustments=(await c.query(`select d.id,d.employee_id as "employeeId",d.kind,d.amount::text,d.currency,d.reason,d.review_status as "reviewStatus",d.reviewed_by as "reviewedBy"
 from payroll_draft_adjustments d where d.company_id=$1 and d.payroll_month=($2||'-01')::date and d.voided_at is null and d.review_status='APPROVED' order by d.id`,[companyId,month])).rows;
 // Round once at the same boundaries as the immutable numeric columns, using PostgreSQL decimal arithmetic.
 const employees:any[]=[];
 for(const e of base.employees){
  const lines=adjustments.filter(d=>d.employeeId===e.employeeId);
  if(lines.some(d=>d.currency!==e.currency))blockers.push('ADJUSTMENT_CURRENCY_MISMATCH');
  const amounts=(await c.query(`with a as (select
 coalesce(sum((d->>'amount')::numeric) filter(where d->>'kind'='BONUS'),0) as bonus,
 coalesce(sum((d->>'amount')::numeric) filter(where d->>'kind'='DEDUCTION'),0) as deductions
 from jsonb_array_elements($1::jsonb) d)
 select bonus::numeric(14,2)::text as "bonusPay",deductions::numeric(14,2)::text as deductions,
 ($2::numeric+$3::numeric+bonus)::numeric(14,2)::text as "grossPay",
 ($2::numeric+$3::numeric+bonus-deductions)::numeric(14,2)::text as "netPay" from a`,[JSON.stringify(lines),e.regularPay,e.overtimePay])).rows[0];
  if(Number(amounts.netPay)<0)blockers.push('DEDUCTIONS_EXCEED_GROSS_PAY');
  const identity=(await c.query(`select employee_number as "employeeNumber",active from employees where company_id=$1 and id=$2`,[companyId,e.employeeId])).rows[0];
  // Inactive staff with earnings remain payable; omit inactive staff with no activity.
  if(!identity.active&&!e.eligibleShifts&&!lines.length)continue;
  const sources=(await c.query(`select s.id,s.branch_id as "branchId",b.name as "branchName",s.starts_at as "startsAt",s.ends_at as "endsAt",
   (extract(epoch from(s.ends_at-s.starts_at))/3600)::numeric(12,4)::text as hours,
   pr.decision,pr.note,
   (select jsonb_agg(to_jsonb(oa) order by oa.id) from shift_overtime_approvals oa where oa.company_id=s.company_id and oa.shift_id=s.id) as overtime
   from shifts s join companies co on co.id=s.company_id join branches b on b.id=s.branch_id and b.company_id=s.company_id
   left join payroll_shift_reviews pr on pr.company_id=s.company_id and pr.shift_id=s.id
   where s.company_id=$1 and s.employee_id=$2 and s.published and to_char(s.starts_at at time zone co.timezone,'YYYY-MM')=$3 order by s.id`,[companyId,e.employeeId,month])).rows;
  const scheduledHours=sources.filter(s=>s.decision!=='CANCELLED').reduce((sum,s)=>sum+Number(s.hours),0);
  employees.push({...e,...identity,...amounts,scheduledHours,adjustments:lines,sourceShifts:sources});
 }
 if(!employees.length)blockers.push('NO_PAYROLL_EMPLOYEES');
 const orphan=adjustments.some(d=>!employees.some(e=>e.employeeId===d.employeeId));if(orphan)blockers.push('ADJUSTMENT_EMPLOYEE_NOT_IN_PAYROLL');
 const data={month,company:{name:company.name,timezone:company.timezone},employees,blockers:[...new Set(blockers)]};
 const previewHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
 return {ok:true,...data,previewHash,approvalAllowed:data.blockers.length===0,
 notice:'Published scheduled hours across all branches. No break deductions. Missing attendance needs a manager decision. Approved overtime replaces hourly base pay for those hours. Monthly salary is fixed; approved bonuses and deductions are applied. Taxes are included only when entered and approved as deductions. Approval is available after the month closes.'};
}

export function registerPayrollRoutes(app:FastifyInstance,db:Pick<Pool,'query'|'connect'>){
 const transaction=async<T>(approve:boolean,fn:(c:PoolClient)=>Promise<T>)=>{
  const c=await db.connect();try{await c.query(approve?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(approve){await c.query("set local lock_timeout='10s'");await c.query(`lock table ${sourceTables} in share row exclusive mode`)}
   const result=await fn(c);await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
 };
 const route=(method:'GET'|'POST',path:string,handler:(req:any,reply:any,a:any)=>Promise<any>)=>app.route({method,url:'/v1/admin/payroll/'+path,handler:async(req,reply)=>{
  const a=requireAdmin(req,reply);if(!a)return;
  reply.header('Cache-Control','no-store');
  if(!['OWNER','ADMIN','MANAGER'].includes(a.role))return reply.code(403).send({ok:false,error:'PAYROLL_ACCESS_DENIED'});
  try{return await handler(req,reply,a)}catch(error:any){
   if(error instanceof z.ZodError)return reply.code(400).send({ok:false,error:'INVALID_PAYROLL_REQUEST'});
   if(error.code==='55P03'||error.code==='40P01')return reply.code(409).send({ok:false,error:'PAYROLL_CHANGED_RETRY'});
   if(error.status)return reply.code(error.status).send({ok:false,error:error.code});
   app.log.error(error);return reply.code(500).send({ok:false,error:'PAYROLL_OPERATION_FAILED'});
  }
 }});
 route('GET','preview',async(req,_reply,a)=>{const {month}=z.object({month:monthSchema}).parse(req.query);return transaction(false,c=>payrollPreview(c,a.companyId,month))});
 route('POST','approve',async(req,reply,a)=>{
  const p=z.object({month:monthSchema,previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
  if(!a.adminId)throw new PayrollError('MANAGER_LOGIN_REQUIRED',403);
  return transaction(true,async c=>{
   const admin=await c.query('select id from company_admins where id=$1 and company_id=$2 and active=true and role in (\'OWNER\',\'ADMIN\',\'MANAGER\')',[a.adminId,a.companyId]);
   if(!admin.rowCount)throw new PayrollError('PAYROLL_ACCESS_DENIED',403);
   const existing=(await c.query(`select id,preview_hash from payroll_runs where company_id=$1 and payroll_month=($2||'-01')::date`,[a.companyId,p.month])).rows[0];
   if(existing){if(existing.preview_hash!==p.previewHash)throw new PayrollError('PAYROLL_ALREADY_APPROVED');return {ok:true,runId:existing.id,alreadyApproved:true}}
   const preview=await payrollPreview(c,a.companyId,p.month);
   if(!preview.approvalAllowed)return reply.code(409).send({ok:false,error:'PAYROLL_BLOCKED',blockers:preview.blockers});
   if(preview.previewHash!==p.previewHash)throw new PayrollError('PAYROLL_CHANGED_REFRESH_PREVIEW');
   const run=(await c.query(`insert into payroll_runs(company_id,payroll_month,preview_hash,approved_by) values($1,($2||'-01')::date,$3,$4) returning id,approved_at`,[a.companyId,p.month,p.previewHash,a.adminId])).rows[0];
   for(const e of preview.employees){
    const data={...e,company:preview.company,month:p.month,runId:run.id,approvedAt:run.approved_at,approvedBy:a.email};
    await c.query(`insert into employee_payroll_snapshots(company_id,employee_id,payroll_month,currency,pay_type,regular_hours,regular_pay,overtime_hours,overtime_pay,bonus_pay,deductions,payslip_data,status,finalised_at,finalised_by)
     values($1,$2,($3||'-01')::date,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'FINALISED',$13,$14)
     on conflict(company_id,employee_id,payroll_month) do update set currency=excluded.currency,pay_type=excluded.pay_type,regular_hours=excluded.regular_hours,regular_pay=excluded.regular_pay,overtime_hours=excluded.overtime_hours,overtime_pay=excluded.overtime_pay,bonus_pay=excluded.bonus_pay,deductions=excluded.deductions,payslip_data=excluded.payslip_data,status=excluded.status,finalised_at=excluded.finalised_at,finalised_by=excluded.finalised_by`,
     [a.companyId,e.employeeId,p.month,e.currency,e.payType,e.regularHours,e.regularPay,e.overtimeHours,e.overtimePay,e.bonusPay,e.deductions,JSON.stringify(data),run.approved_at,a.adminId]);
   }
   await c.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata) values($1,'ADMIN',$2,'APPROVE_PAYROLL','PAYROLL_RUN',$3,$4::jsonb)`,[a.companyId,a.adminId,run.id,JSON.stringify({month:p.month,employees:preview.employees.length,previewHash:p.previewHash})]);
   return {ok:true,runId:run.id,employees:preview.employees.length};
  });
 });
 route('GET','payslips',async(req,_reply,a)=>{
  const {month}=z.object({month:monthSchema}).parse(req.query);
  const r=await db.query(`select id,payslip_data as data from employee_payroll_snapshots where company_id=$1 and payroll_month=($2||'-01')::date and status='FINALISED' and payslip_data is not null order by payslip_data->>'employeeName'`,[a.companyId,month]);return {ok:true,month,payslips:r.rows};
 });
 route('GET','payslips/:id/download',async(req,reply,a)=>{
  const {id}=z.object({id:z.uuid()}).parse(req.params);
  const r=await db.query(`select payslip_data as data from employee_payroll_snapshots where id=$1 and company_id=$2 and status='FINALISED' and payslip_data is not null`,[id,a.companyId]);
  if(!r.rowCount)throw new PayrollError('PAYSLIP_NOT_FOUND',404);
  const bytes=await renderPayslip(r.rows[0].data,id);
  return reply.type('application/pdf').header('Content-Disposition',`attachment; filename="payslip-${r.rows[0].data.month}-${id}.pdf"`).send(bytes);
 });
}

export async function renderPayslip(data:any,id:string):Promise<Buffer>{
 const doc=new PDFDocument({size:'A4',margin:48,info:{Title:`Payslip ${data.month}`,Author:data.company.name}});
 const chunks:Buffer[]=[];const result=new Promise<Buffer>((resolve,reject)=>{doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
 doc.font(fileURLToPath(new URL('../assets/PayslipSans.ttf',import.meta.url)));
 doc.fontSize(22).text(data.company.name).moveDown(.5).fontSize(17).text('Employee payslip');
 doc.fontSize(10).text(`Payroll month: ${data.month}`).text(`Employee: ${data.employeeName}`).text(`Employee number: ${data.employeeNumber}`).text(`Pay basis: ${data.payType==='MONTHLY'?'Monthly salary':'Hourly'}`).text(`Currency: ${data.currency}`).moveDown();
 const line=(label:string,amount:unknown)=>doc.fontSize(11).text(`${label}: ${data.currency} ${Number(amount).toFixed(2)}`);
 doc.text(`Scheduled hours: ${Number(data.scheduledHours).toFixed(2)}`).text(`Approved overtime hours: ${Number(data.overtimeHours).toFixed(2)}`).text(`Published shifts: ${data.eligibleShifts}`).moveDown();
 line('Regular pay',data.regularPay);line('Overtime pay',data.overtimePay);line('Bonuses',data.bonusPay);line('Gross earnings',data.grossPay);line('Deductions',data.deductions);doc.moveDown();line('Net payable',data.netPay);
 if(data.adjustments.length){doc.moveDown().fontSize(12).text('Approved adjustments');for(const a of data.adjustments)doc.fontSize(10).text(`${a.kind}: ${data.currency} ${Number(a.amount).toFixed(2)} - ${a.reason}`)}
 doc.moveDown().fontSize(9).text('Scheduled pay across all branches. No break deductions. Taxes appear only as manager-entered approved deductions. This document records approved payroll; it is not confirmation of payment.').moveDown().text(`Approved by: ${data.approvedBy}`).text(`Approved at: ${new Date(data.approvedAt).toISOString()}`).text(`Payslip reference: ${id}`).text(`Payroll run: ${data.runId}`);
 doc.end();return result;
}
