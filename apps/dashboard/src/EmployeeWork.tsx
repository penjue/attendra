import React,{useEffect,useState} from 'react';
type Task={id:string;title:string;description:string;status:string;dueAt:string|null};
type Incident={id:string;category:string;description:string;status:string;occurredAt:string};
export function EmployeeWork({api,token}:{api:string;token:string}){
 const [tasks,setTasks]=useState<Task[]>([]),[incidents,setIncidents]=useState<Incident[]>([]);
 const [category,setCategory]=useState('SAFETY'),[description,setDescription]=useState('');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const headers={Authorization:`Bearer ${token}`};
 const load=async()=>{setLoading(true);setError('');try{
  const [t,i]=await Promise.all([fetch(`${api}/v1/employee/tasks`,{headers}),fetch(`${api}/v1/employee/incidents`,{headers})]);
  if(!t.ok||!i.ok)throw Error('Could not load tasks and reports');
  setTasks((await t.json()).tasks);setIncidents((await i.json()).incidents);
 }catch(e){setError(e instanceof Error?e.message:'Loading failed')}finally{setLoading(false)}};
 useEffect(()=>{void load()},[api,token]);
 const update=async(id:string,status:'IN_PROGRESS'|'COMPLETED')=>{setBusy(true);setError('');setNotice('');try{
  const r=await fetch(`${api}/v1/employee/tasks/${id}/status`,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({status})});
  if(!r.ok)throw Error('Could not update task');setNotice('Task updated');await load();
 }catch(e){setError(e instanceof Error?e.message:'Update failed')}finally{setBusy(false)}};
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');setNotice('');try{
  const r=await fetch(`${api}/v1/employee/incidents`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({category,description,occurredAt:new Date().toISOString()})});
  if(!r.ok)throw Error('Could not submit incident');setDescription('');setNotice('Incident submitted');await load();
 }catch(e){setError(e instanceof Error?e.message:'Submission failed')}finally{setBusy(false)}};
 return <section className="panel"><h2>My tasks & incidents</h2>
  {error&&<p className="errorBox" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <h3>Assigned tasks</h3>{loading?<p>Loading…</p>:tasks.length===0?<p>No assigned tasks.</p>:<ul>{tasks.map(t=><li key={t.id}><strong>{t.title}</strong> — {t.status}<p>{t.description}</p>{t.status==='PENDING'&&<button disabled={busy} onClick={()=>update(t.id,'IN_PROGRESS')}>Start</button>}{(t.status==='PENDING'||t.status==='IN_PROGRESS')&&<button disabled={busy} onClick={()=>update(t.id,'COMPLETED')}>Complete</button>}</li>)}</ul>}
  <h3>Report an incident</h3><form className="loginForm" onSubmit={submit}>
   <label>Category<select value={category} onChange={e=>setCategory(e.target.value)}>{['SAFETY','INJURY','EQUIPMENT','SECURITY','OTHER'].map(c=><option key={c}>{c}</option>)}</select></label>
   <label>What happened?<textarea required minLength={10} maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
   <button className="primary" disabled={busy||description.trim().length<10}>{busy?'Submitting…':'Submit incident'}</button>
  </form>
  <h3>My incident history</h3>{loading?<p>Loading…</p>:incidents.length===0?<p>No incidents submitted.</p>:<ul>{incidents.map(i=><li key={i.id}><strong>{i.category}</strong> — {i.status}<p>{i.description}</p><small>{new Date(i.occurredAt).toLocaleString()}</small></li>)}</ul>}
 </section>;
}
