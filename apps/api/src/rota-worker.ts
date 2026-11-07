/**
 * Run as a separate scheduled process (e.g. Render Cron), not from each API
 * instance. Requires DATABASE_URL and ADMIN_TOKEN_SECRET.
 * Creates unpublished drafts only; manager publication remains separate.
 */
import Fastify from 'fastify';
import {db} from './db.js';
import {signAdminToken} from './admin-auth.js';
import {registerRotaOccurrenceRoutes} from './rota-occurrences.js';

if(process.env.ATTENDRA_ROTA_WORKER_ENABLED!=='true')throw new Error('Rota worker disabled: set ATTENDRA_ROTA_WORKER_ENABLED=true');
if(process.env.ATTENDRA_ROTA_WORKER_ENV!=='staging')throw new Error('Rota worker is staging-only until production rollout is approved');
if(!process.env.ADMIN_TOKEN_SECRET)throw new Error('ADMIN_TOKEN_SECRET is required');
const app=Fastify({logger:true});
registerRotaOccurrenceRoutes(app,db);
try{
 const due=await db.query(`select r.id,t.company_id from rota_recurrences r
 join rota_templates t on t.id=r.template_id
 where r.status='ACTIVE' and t.status='APPROVED'
 and r.next_period_start <= (current_date + interval '7 days')::date
 order by r.next_period_start,r.id limit 25`);
 let created=0,blocked=0;
 for(const item of due.rows){
  const token=signAdminToken({companyId:item.company_id,email:'rota-worker@internal.attendra',role:'MANAGER',exp:Date.now()+60000});
  const response=await app.inject({method:'POST',url:`/v1/admin/rota-recurrences/${item.id}/generate-next`,headers:{authorization:`Bearer ${token}`}});
  const result=response.json();
  if(response.statusCode===200){created++;app.log.info({recurrenceId:item.id,created:result.created},'Rota drafts prepared')}
  else {blocked++;app.log.warn({recurrenceId:item.id,status:response.statusCode,error:result.error,skipped:result.skipped},'Rota recurrence needs attention')}
 }
 app.log.info({checked:due.rowCount,created,blocked},'Rota recurrence worker finished');
 if(blocked)process.exitCode=1;
}finally{
 await app.close();
 await db.end();
}
