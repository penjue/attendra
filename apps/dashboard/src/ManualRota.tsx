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
 const [draftShifts,setDraftShifts]=useState<RotaShift[]>([]),[editingIndex,setEditingIndex]=useState<number|null>(null),[zoom,setZoom]=useState(90);
 const [endMode,setEndMode]=useState<'UNTIL_STOPPED'|'ON_DATE'>('UNTIL_STOPPED'),[endDate,setEndDate]=useState('');
 const [restoreNotice,setRestoreNotice]=useState(false);
 const [recoveryReady,setRecoveryReady]=useState(false);
 const storageKey='attendra:rota:unsaved:v1';
 useEffect(()=>{
  try {
   const raw=sessionStorage.getItem(storageKey);
   if(raw){
    const d=JSON.parse(raw);
    if(d.api===api&&Array.isArray(d.shifts)&&d.shifts.length){
     setPeriod(d.period==='MONTHLY'?'MONTHLY':'WEEKLY');
     setBranch(d.branch||'');setAnchor(d.anchor||'');
     setDraftShifts(d.shifts.filter((x:RotaShift)=>x&&typeof x.employeeId==='string'&&Number.isInteger(x.dayOffset)));
     setEndMode(d.endMode==='ON_DATE'?'ON_DATE':'UNTIL_STOPPED');setEndDate(d.endDate||'');
     setRestoreNotice(true);
    }
   }
  }catch{}
  setRecoveryReady(true);
 },[api]);
 useEffect(()=>{
  if(!recoveryReady)return;
  try {
   if(draftShifts.length)sessionStorage.setItem(storageKey,JSON.stringify({api,period,branch,anchor,shifts:draftShifts,endMode,endDate}));
   else sessionStorage.removeItem(storageKey);
  }catch{}
 },[recoveryReady,api,period,branch,anchor,draftShifts,endMode,endDate]);
 const discardUnsaved=()=>{setDraftShifts([]);setEditingIndex(null);setRestoreNotice(false);try{sessionStorage.removeItem(storageKey)}catch{}setMessage('Unfinished rota discarded.')};
 const call=async(path:string,method='GET',body?:unknown)=>{const r=await fetch(`${api}/v1/admin/${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.skipped?.length?`${d.error}: ${d.skipped.join(', ')}. Resolve conflicts and retry.`:(d.error||'Request failed'));return d};
 const refresh=async()=>{const [t,r]=await Promise.all([call('rota-templates'),call('rota-recurrences')]);setTemplates(t.templates);setRecurrences(r.recurrences)};
 useEffect(()=>{void refresh().catch(e=>setMessage(e.message))},[api,token]);
 const execute=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await fn();await refresh()}catch(e){setMessage((e as Error).message)}finally{setBusy(false)}};
 const addShift=()=>{if(!employee){setMessage('Select an employee first.');return}
  if(!Number.isInteger(dayOffset)||dayOffset<0||dayOffset>(period==='WEEKLY'?6:30)){setMessage('Invalid day offset.');return}
  if(!Number.isFinite(breakMinutes)||breakMinutes<0){setMessage('Invalid break duration.');return}
  const shift={employeeId:employee,dayOffset,startTime:start,endTime:end,breakMinutes,endDayOffset:end<=start?1:0};
  if(draftShifts.some((s,i)=>i!==editingIndex&&s.employeeId===employee&&s.dayOffset===dayOffset&&s.startTime===start&&s.endTime===end)){setMessage('This shift is already in the rota.');return}
  setDraftShifts(v=>editingIndex===null?[...v,shift]:v.map((s,i)=>i===editingIndex?shift:s));setMessage(editingIndex===null?'Shift added to the rota draft.':'Shift updated.');setEditingIndex(null)};
 const editShift=(s:RotaShift,i:number)=>{setEmployee(s.employeeId);setDayOffset(s.dayOffset);setStart(s.startTime);setEnd(s.endTime);setBreakMinutes(s.breakMinutes);setEditingIndex(i);setMessage('Edit the fields, then save shift changes.')};
 const sortedShifts=draftShifts.map((s,i)=>({s,i})).sort((a,b)=>a.s.dayOffset-b.s.dayOffset||a.s.startTime.localeCompare(b.s.startTime));
 const dayLabel=(n:number)=>period==='WEEKLY'?(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][n]||'Day '+(n+1)):'Day '+(n+1);
 const create=()=>void execute(async()=>{
  if(!branch||!anchor||!draftShifts.length)throw Error('Select a branch, start date and add at least one shift');
  const day=new Date(anchor+'T00:00:00Z');
  if(period==='WEEKLY'&&day.getUTCDay()!==1)throw Error('Weekly rotas start on Monday');
  if(period==='MONTHLY'&&day.getUTCDate()!==1)throw Error('Monthly rotas start on the first day of the month');
  const d=await call('rota-templates','POST',{branchId:branch,periodType:period,anchorStartDate:anchor,shifts:draftShifts});
  setMessage('Rota pattern saved. Approving a pattern does not publish employee shifts. Use the calendar to review and publish generated drafts.');
  if(!d.templateId)throw Error('Template was not returned');
  setDraftShifts([]);setEditingIndex(null);
 });
 const approve=(id:string)=>void execute(async()=>{await call(`rota-templates/${id}/approve`,'POST');setMessage('Rota pattern approved for reuse. No employee shifts have been published. Enable repetition to generate drafts.')});
 const startRepeat=(id:string)=>void execute(async()=>{if(endMode==='ON_DATE'&&!endDate)throw Error('Select a repetition end date');await call(`rota-templates/${id}/recurrence`,'POST',{endMode,...(endMode==='ON_DATE'?{endDate}:{})});setMessage('Repetition configured. Click Generate next draft, then review and publish shifts in the calendar. This does not automatically publish.')});
 const setStatus=(id:string,status:'ACTIVE'|'PAUSED'|'STOPPED')=>void execute(async()=>{await call(`rota-recurrences/${id}/status`,'POST',{status});setMessage('Recurrence updated.')});
 const generate=(id:string)=>void execute(async()=>{const r=await call(`rota-recurrences/${id}/generate-next`,'POST');setMessage(`${r.created} draft shifts created. ${r.skipped?.length||0} exceptions. Review them in the weekly calendar and use Publish selected drafts when ready.`)});
 return <section className="panel"><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,flexWrap:'wrap'}}><h2>Create Weekly / Monthly Rota Pattern</h2><div style={{display:'flex',alignItems:'center',gap:5}}><button type="button" aria-label="Zoom out" disabled={zoom<=70} onClick={()=>setZoom(z=>Math.max(70,z-10))}>−</button><span>{zoom}%</span><button type="button" aria-label="Zoom in" disabled={zoom>=120} onClick={()=>setZoom(z=>Math.min(120,z+10))}>+</button><button type="button" onClick={()=>setZoom(90)}>Reset zoom</button></div></div><div style={{zoom:zoom+'%',fontSize:'0.85rem'}}><p>Build a reusable rota pattern with employee shifts. Approving the pattern does not publish shifts. Generate drafts separately and publish them from the calendar after review.</p>
 {restoreNotice&&<p role="status">Your unfinished rota was restored from this browser tab.</p>}
 {draftShifts.length>0&&<p>Unfinished shifts are saved in this browser tab while you work. <button type="button" disabled={busy} onClick={discardUnsaved}>Discard unfinished rota</button></p>}
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
 <button type="button" disabled={busy||!employee} onClick={addShift}>{editingIndex===null?'Add shift to rota':'Save shift changes'}</button>{editingIndex!==null&&<button type="button" onClick={()=>{setEditingIndex(null);setMessage('Editing cancelled.')}}>Cancel edit</button>}
 <div><strong>Shifts in this rota: {draftShifts.length}</strong>{sortedShifts.map(({s,i})=><div className="attendanceRow" key={i} style={{padding:'4px 6px',gap:6,fontSize:'0.85em'}}><span>{dayLabel(s.dayOffset)} · {employees.find(e=>e.id===s.employeeId)?.name||'Employee'} · {s.startTime}–{s.endTime} · {s.breakMinutes} min break</span><div style={{display:'flex',gap:4}}><button type="button" disabled={busy} onClick={()=>editShift(s,i)}>Edit</button><button type="button" disabled={busy} onClick={()=>{setDraftShifts(v=>v.filter((_,j)=>j!==i));setEditingIndex(null)}}>Remove</button></div></div>)}</div>
 <button type="button" className="primary" disabled={busy||!draftShifts.length} onClick={create}>Save rota draft</button>
 </div>
 <p>Build the full weekly or monthly schedule by adding shifts above. Saved patterns cannot yet be edited. Generated shifts must be reviewed and published separately in the existing calendar.</p>
 <h3>Rota templates</h3>{templates.map(t=><div className="attendanceRow" key={t.id}><div><strong>{t.periodType} · {t.anchorStartDate?.slice(0,10)}</strong><p>{t.shiftCount} shift(s) · {t.status}</p></div>{t.status==='DRAFT'?<button disabled={busy} onClick={()=>approve(t.id)}>Approve pattern</button>:t.status==='APPROVED'&&!recurrences.some(r=>r.templateId===t.id&&r.status!=='STOPPED')?<button disabled={busy} onClick={()=>startRepeat(t.id)}>Enable draft repetition</button>:null}</div>)}
 <h3>Recurring schedules</h3>{recurrences.map(r=><div className="attendanceRow" key={r.id}><div><strong>{r.cadence} · {r.status}</strong><p>Next: {r.nextPeriodStart} · {r.occurrenceCount} occurrence(s)</p></div><div>{r.status==='ACTIVE'&&<><button disabled={busy} onClick={()=>generate(r.id)}>Generate next draft</button><button disabled={busy} onClick={()=>setStatus(r.id,'PAUSED')}>Pause</button></>}{r.status==='PAUSED'&&<button disabled={busy} onClick={()=>setStatus(r.id,'ACTIVE')}>Resume</button>}{r.status!=='STOPPED'&&<button disabled={busy} onClick={()=>setStatus(r.id,'STOPPED')}>Stop</button>}</div></div>)}
 {message&&<p role="status">{message}</p>}
 </div></section>;
}
