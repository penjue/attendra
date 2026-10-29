import React,{useEffect,useState} from 'react';
type Employee={id:string;name:string;employeeNumber:string};
type Branch={id:string;name:string};
type Template={id:string;branchId:string;periodType:'WEEKLY'|'MONTHLY';anchorStartDate:string;status:string;shiftCount:number};
type RotaShift={employeeId:string;dayOffset:number;startTime:string;endTime:string;breakMinutes:number;endDayOffset:number};
type Recurrence={id:string;templateId:string;cadence:string;status:string;endMode:string;endDate:string|null;nextPeriodStart:string;occurrenceCount:number};
export function ManualRota({api,token,employees,branches}:{api:string;token:string;employees:Employee[];branches:Branch[]}){
 const [templates,setTemplates]=useState<Template[]>([]),[recurrences,setRecurrences]=useState<Recurrence[]>([]);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [period,setPeriod]=useState<'WEEKLY'|'MONTHLY'>('WEEKLY'),[branch,setBranch]=useState(''),[anchor,setAnchor]=useState(''),[employee,setEmployee]=useState('');
 const [dayOffset,setDayOffset]=useState(0),[start,setStart]=useState('07:00'),[end,setEnd]=useState('15:00'),[breakMinutes,setBreakMinutes]=useState(60);
 const [draftShifts,setDraftShifts]=useState<RotaShift[]>([]);
 const [endMode,setEndMode]=useState<'UNTIL_STOPPED'|'ON_DATE'>('UNTIL_STOPPED'),[endDate,setEndDate]=useState('');
 const call=async(path:string,method='GET',body?:unknown)=>{const r=await fetch(`${api}/v1/admin/${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.skipped?.length?`${d.error}: ${d.skipped.join(', ')}. Resolve conflicts and retry.`:(d.error||'Request failed'));return d};
 const refresh=async()=>{const [t,r]=await Promise.all([call('rota-templates'),call('rota-recurrences')]);setTemplates(t.templates);setRecurrences(r.recurrences)};
 useEffect(()=>{void refresh().catch(e=>setMessage(e.message))},[api,token]);
 const execute=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await fn();await refresh()}catch(e){setMessage((e as Error).message)}finally{setBusy(false)}};
 const addShift=()=>{if(!employee){setMessage('Select an employee first.');return}
  setDraftShifts(v=>[...v,{employeeId:employee,dayOffset,startTime:start,endTime:end,breakMinutes,endDayOffset:end<=start?1:0}]);setMessage('Shift added to the rota draft.')};
 const create=()=>void execute(async()=>{
  if(!branch||!anchor||!draftShifts.length)throw Error('Select a branch, start date and add at least one shift');
  const day=new Date(anchor+'T00:00:00Z');
  if(period==='WEEKLY'&&day.getUTCDay()!==1)throw Error('Weekly rotas start on Monday');
  if(period==='MONTHLY'&&day.getUTCDate()!==1)throw Error('Monthly rotas start on the first day of the month');
  const d=await call('rota-templates','POST',{branchId:branch,periodType:period,anchorStartDate:anchor,shifts:draftShifts});
  setMessage('Rota pattern saved. Approving a pattern does not publish employee shifts. Use the calendar to review and publish generated drafts.');
  if(!d.templateId)throw Error('Template was not returned');
  setDraftShifts([]);
 });
 const approve=(id:string)=>void execute(async()=>{await call(`rota-templates/${id}/approve`,'POST');setMessage('Rota pattern approved for reuse. No employee shifts have been published. Enable repetition to generate drafts.')});
 const startRepeat=(id:string)=>void execute(async()=>{if(endMode==='ON_DATE'&&!endDate)throw Error('Select a repetition end date');await call(`rota-templates/${id}/recurrence`,'POST',{endMode,...(endMode==='ON_DATE'?{endDate}:{})});setMessage('Repetition configured. Click Generate next draft, then review and publish shifts in the calendar. This does not automatically publish.')});
 const setStatus=(id:string,status:'ACTIVE'|'PAUSED'|'STOPPED')=>void execute(async()=>{await call(`rota-recurrences/${id}/status`,'POST',{status});setMessage('Recurrence updated.')});
 const generate=(id:string)=>void execute(async()=>{const r=await call(`rota-recurrences/${id}/generate-next`,'POST');setMessage(`${r.created} draft shifts created. ${r.skipped?.length||0} exceptions. Review them in the weekly calendar and use Publish selected drafts when ready.`)});
 return <section className="panel"><h2>Create Weekly / Monthly Rota Pattern</h2><p>Build a reusable rota pattern with employee shifts. Approving the pattern does not publish shifts. Generate drafts separately and publish them from the calendar after review.</p>
 <div className="plannerForm">
 <label>Rota type<select value={period} onChange={e=>setPeriod(e.target.value as 'WEEKLY'|'MONTHLY')}><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label>
 <label>Branch<select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">Select branch</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
 <label>Start date<input type="date" value={anchor} onChange={e=>setAnchor(e.target.value)}/></label>
 <label>Employee<select value={employee} onChange={e=>setEmployee(e.target.value)}><option value="">Select employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name} · {e.employeeNumber}</option>)}</select></label>
 <label>Day offset (0 = first day)<input type="number" min="0" max={period==='WEEKLY'?6:30} value={dayOffset} onChange={e=>setDayOffset(Number(e.target.value))}/></label>
 <label>Start time<input type="time" value={start} onChange={e=>setStart(e.target.value)}/></label>
 <label>End time<input type="time" value={end} onChange={e=>setEnd(e.target.value)}/></label>
 <label>Unpaid break (minutes)<input type="number" min="0" max="720" value={breakMinutes} onChange={e=>setBreakMinutes(Number(e.target.value))}/></label>

 <label>Repeat ends<select value={endMode} onChange={e=>setEndMode(e.target.value as 'UNTIL_STOPPED'|'ON_DATE')}><option value="UNTIL_STOPPED">When manager stops it</option><option value="ON_DATE">On selected date</option></select></label>{endMode==='ON_DATE'&&<label>End date<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}/></label>}
 <button type="button" disabled={busy||!employee} onClick={addShift}>Add shift to rota</button>
 <div><strong>Shifts in this rota: {draftShifts.length}</strong>{draftShifts.map((s,i)=><div className="attendanceRow" key={i}><span>{employees.find(e=>e.id===s.employeeId)?.name||'Employee'} · Day {s.dayOffset+1} · {s.startTime}–{s.endTime} · {s.breakMinutes} min break</span><button type="button" disabled={busy} onClick={()=>setDraftShifts(v=>v.filter((_,j)=>j!==i))}>Remove</button></div>)}</div>
 <button type="button" className="primary" disabled={busy||!draftShifts.length} onClick={create}>Save rota draft</button>
 </div>
 <p>Build the full weekly or monthly schedule by adding shifts above. Saved patterns cannot yet be edited. Generated shifts must be reviewed and published separately in the existing calendar.</p>
 <h3>Rota templates</h3>{templates.map(t=><div className="attendanceRow" key={t.id}><div><strong>{t.periodType} · {t.anchorStartDate?.slice(0,10)}</strong><p>{t.shiftCount} shift(s) · {t.status}</p></div>{t.status==='DRAFT'?<button disabled={busy} onClick={()=>approve(t.id)}>Approve pattern</button>:t.status==='APPROVED'&&!recurrences.some(r=>r.templateId===t.id&&r.status!=='STOPPED')?<button disabled={busy} onClick={()=>startRepeat(t.id)}>Enable draft repetition</button>:null}</div>)}
 <h3>Recurring schedules</h3>{recurrences.map(r=><div className="attendanceRow" key={r.id}><div><strong>{r.cadence} · {r.status}</strong><p>Next: {r.nextPeriodStart} · {r.occurrenceCount} occurrence(s)</p></div><div>{r.status==='ACTIVE'&&<><button disabled={busy} onClick={()=>generate(r.id)}>Generate next draft</button><button disabled={busy} onClick={()=>setStatus(r.id,'PAUSED')}>Pause</button></>}{r.status==='PAUSED'&&<button disabled={busy} onClick={()=>setStatus(r.id,'ACTIVE')}>Resume</button>}{r.status!=='STOPPED'&&<button disabled={busy} onClick={()=>setStatus(r.id,'STOPPED')}>Stop</button>}</div></div>)}
 {message&&<p role="status">{message}</p>}
 </section>;
}
