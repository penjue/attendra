import React, { useEffect, useState } from 'react';

type Task={id:string;employeeId:string;title:string;description:string;status:string;dueAt:string|null};
type Incident={id:string;employeeId:string;category:string;description:string;status:string;occurredAt:string};
type Employee={id:string;firstName:string;lastName:string;employeeNumber:string};
export function WorkManagement({api,token,employees}:{api:string;token:string;employees:Employee[]}){
 const [tasks,setTasks]=useState<Task[]>([]);
 const [incidents,setIncidents]=useState<Incident[]>([]);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [employeeId,setEmployeeId]=useState('');
 const [title,setTitle]=useState('');
 const [description,setDescription]=useState('');
 const headers={Authorization:`Bearer ${token}`};
 const load=async()=>{
  setLoading(true);setError('');
  try{
   const [t,i]=await Promise.all([
    fetch(`${api}/v1/admin/tasks`,{headers}),
    fetch(`${api}/v1/admin/incidents`,{headers})
   ]);
   if(!t.ok||!i.ok)throw Error('Unable to load tasks or incidents');
   setTasks((await t.json()).tasks);setIncidents((await i.json()).incidents);
  }catch(e){setError(e instanceof Error?e.message:'Unable to load work management');}
  finally{setLoading(false)}
 };
 useEffect(()=>{void load()},[api,token]);
 const create=async(e:React.FormEvent)=>{
  e.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
  try{
   const r=await fetch(`${api}/v1/admin/tasks`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({employeeId,title,description})});
   if(!r.ok)throw Error('Task could not be assigned');
   setTitle('');setDescription('');setNotice('Task assigned successfully');await load();
  }catch(e){setError(e instanceof Error?e.message:'Task failed')}finally{setBusy(false)}
 };
 const review=async(id:string,status:'UNDER_REVIEW'|'RESOLVED')=>{
  if(busy)return;setBusy(true);setError('');setNotice('');
  try{
   const r=await fetch(`${api}/v1/admin/incidents/${id}/status`,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({status})});
   if(!r.ok)throw Error('Could not update incident');
   setNotice('Incident updated');await load();
  }catch(e){setError(e instanceof Error?e.message:'Update failed')}finally{setBusy(false)}
 };
 return <div>
  <section className="panel"><h2>Assign employee task</h2>
   <form className="loginForm" onSubmit={create}>
    <label>Employee<select required value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">Choose employee</option>{employees.filter(e=>e.id).map(e=><option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeNumber})</option>)}</select></label>
    <label>Task title<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Instructions<textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <button className="primary" disabled={busy||!employeeId}>{busy?'Saving…':'Assign task'}</button>
   </form>
  </section>
  {error&&<p className="errorBox" role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  <section className="panel"><h2>Assigned tasks</h2>{loading?<p>Loading…</p>:tasks.length===0?<p>No tasks assigned yet.</p>:<ul>{tasks.map(t=><li key={t.id}><strong>{t.title}</strong> — {t.status}<p>{t.description}</p></li>)}</ul>}</section>
  <section className="panel"><h2>Incident reports</h2>{loading?<p>Loading…</p>:incidents.length===0?<p>No incidents reported.</p>:<ul>{incidents.map(i=><li key={i.id}><strong>{i.category}</strong> — {i.status}<p>{i.description}</p><small>{new Date(i.occurredAt).toLocaleString()}</small> {i.status!=='RESOLVED'&&<><button disabled={busy} onClick={()=>review(i.id,'UNDER_REVIEW')}>Review</button><button disabled={busy} onClick={()=>review(i.id,'RESOLVED')}>Resolve</button></>}</li>)}</ul>}</section>
 </div>;
}
