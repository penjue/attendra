(() => {
  const API_URL = 'https://attendra-api.onrender.com';
  const REFRESH_MS = 15000;
  const DEVICE_RECENT_MS = 3 * 60 * 1000;
  const ACK_KEY = 'attendra_hq_ack_alerts_v1';
  let loading = false;
  let lastAlertKeys = new Set();

  const styles = `
    .attAlerts{margin-top:20px;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px}
    .attAlertsHead{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:14px}
    .attAlertsHead h2{margin:0}.attAlertsHead span{display:block;color:#64748b;font-size:13px;margin-top:4px;line-height:1.4}
    .attAlertActions{display:flex;gap:8px;flex-wrap:wrap}.attAlertBtn{border:1px solid #cbd5e1;background:#fff;border-radius:10px;padding:8px 11px;cursor:pointer;font:inherit}
    .attAlertBtn.primary{background:#0f172a;color:#fff;border-color:#0f172a}.attAlertBtn:disabled{opacity:.5;cursor:not-allowed}
    .attAlertStats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}
    .attAlertStat{border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:#f8fafc}.attAlertStat strong{display:block;font-size:22px}.attAlertStat span{display:block;color:#64748b;font-size:12px;margin-top:3px}
    .attAlertList{display:grid;gap:10px}.attAlert{display:flex;justify-content:space-between;gap:12px;border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:#fff}
    .attAlert.high{border-color:#fecaca;background:#fff7f7}.attAlert.medium{border-color:#fed7aa;background:#fffaf5}.attAlert.low{border-color:#bfdbfe;background:#f8fbff}
    .attAlert h3{font-size:14px;margin:0}.attAlert p{font-size:12px;color:#64748b;margin:4px 0 0;line-height:1.45}.attAlertMeta{font-size:11px;color:#64748b;margin-top:5px}
    .attAlertSide{display:flex;flex-direction:column;align-items:flex-end;gap:8px}.attSeverity{border-radius:999px;padding:4px 7px;font-size:10px;font-weight:700;white-space:nowrap}.attSeverity.high{background:#fef2f2;color:#b91c1c}.attSeverity.medium{background:#fff7ed;color:#c2410c}.attSeverity.low{background:#eff6ff;color:#1d4ed8}
    .attAck{border:1px solid #cbd5e1;background:#fff;border-radius:9px;padding:6px 8px;font-size:11px;cursor:pointer}.attAlertEmpty{color:#64748b;font-size:13px;padding:10px 0}
    @media(max-width:720px){.attAlertsHead{flex-direction:column}.attAlertStats{grid-template-columns:repeat(2,1fr)}.attAlert{align-items:flex-start}.attAlertSide{min-width:86px}}
  `;
  const style = document.createElement('style'); style.textContent = styles; document.head.appendChild(style);

  const esc = v => String(v ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
  const tokenInfo = () => {
    const token = sessionStorage.getItem('attendra_admin_token'); if (!token) return null;
    try { const body = token.split('.')[0]; const json = JSON.parse(atob(body.replace(/-/g,'+').replace(/_/g,'/'))); return { token, companyId: json.companyId }; } catch { return null; }
  };
  const api = async (path, token) => { const r = await fetch(`${API_URL}${path}`, { headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'} }); if(!r.ok) throw new Error('ALERT_API_FAILED'); return r.json(); };
  const acked = () => { try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || '[]')); } catch { return new Set(); } };
  const saveAck = key => { const s = acked(); s.add(key); localStorage.setItem(ACK_KEY, JSON.stringify([...s].slice(-250))); };
  const fmtTime = v => v ? new Date(v).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—';

  const findHost = () => {
    const active = [...document.querySelectorAll('.tabs button')].find(b => b.classList.contains('active'));
    if (!active || active.textContent.trim() !== 'Overview') return null;
    return document.getElementById('hq-live-overview') || document.querySelector('.shell');
  };

  const localDayRange = () => {
    const from = new Date(); from.setHours(0,0,0,0);
    const to = new Date(from); to.setDate(to.getDate()+1);
    return { from: from.toISOString(), to: to.toISOString() };
  };

  const makeAlerts = (entries, devices) => {
    const now = Date.now(); const alerts = [];
    for (const e of entries) {
      if (e.status === 'MISSED') alerts.push({key:`missed:${e.shiftId}`,severity:'high',type:'Missed shift',title:`${e.employeeName} has not arrived`,detail:`${e.branchName} · shift ${fmtTime(e.scheduledStart)}–${fmtTime(e.scheduledEnd)}`,at:e.scheduledStart});
      else if (e.status === 'OPEN' && e.scheduledEnd && now > new Date(e.scheduledEnd).getTime() + 15*60000) alerts.push({key:`checkout:${e.shiftId}`,severity:'high',type:'Missing checkout',title:`${e.employeeName} is still clocked in`,detail:`${e.branchName} · shift ended ${fmtTime(e.scheduledEnd)}`,at:e.scheduledEnd});
      if ((e.lateMinutes || 0) > 0 && e.checkInAt) alerts.push({key:`late:${e.shiftId}:${e.checkInAt}`,severity:'medium',type:'Late arrival',title:`${e.employeeName} arrived ${e.lateMinutes} min late`,detail:`${e.branchName} · checked in ${fmtTime(e.checkInAt)}`,at:e.checkInAt});
    }
    for (const d of devices.filter(x => x.active)) {
      const last = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
      if (d.online) continue;
      if (last && now-last <= DEVICE_RECENT_MS) alerts.push({key:`device-recent:${d.id}:${d.lastSeenAt}`,severity:'medium',type:'Tablet connection',title:`${d.name} recently disconnected`,detail:`${d.branchName} · last heartbeat ${fmtTime(d.lastSeenAt)}`,at:d.lastSeenAt});
      else alerts.push({key:`device-offline:${d.id}`,severity:'high',type:'Tablet offline',title:`${d.name} is offline`,detail:`${d.branchName} · ${d.lastSeenAt ? `last heartbeat ${new Date(d.lastSeenAt).toLocaleString()}` : 'no heartbeat recorded'}`,at:d.lastSeenAt});
    }
    return alerts.sort((a,b) => ({high:3,medium:2,low:1}[b.severity]-({high:3,medium:2,low:1}[a.severity]) || new Date(b.at||0)-new Date(a.at||0));
  };

  const notifyNew = alerts => {
    if (!('Notification' in window) || Notification.permission !== 'granted') { lastAlertKeys = new Set(alerts.map(a=>a.key)); return; }
    const current = new Set(alerts.map(a=>a.key));
    for (const a of alerts) if (!lastAlertKeys.has(a.key) && a.severity === 'high') {
      try { new Notification(`Attendra: ${a.type}`, { body: `${a.title}. ${a.detail}`, tag:a.key }); } catch {}
    }
    lastAlertKeys = current;
  };

  const render = (panel, alerts) => {
    const acks = acked(); const visible = alerts.filter(a => !acks.has(a.key));
    const high = visible.filter(a=>a.severity==='high').length, medium = visible.filter(a=>a.severity==='medium').length;
    const late = visible.filter(a=>a.type==='Late arrival').length, devices = visible.filter(a=>a.type.includes('Tablet')).length;
    const notifState = !('Notification' in window) ? 'Unsupported' : Notification.permission === 'granted' ? 'Browser alerts on' : 'Enable browser alerts';
    panel.innerHTML = `<div class="attAlertsHead"><div><h2>Alerts & notifications</h2><span>Operational exceptions that need management attention. High-priority browser notifications can be enabled on this device.</span></div><div class="attAlertActions"><button class="attAlertBtn primary" id="att-enable-notifications" ${!('Notification' in window)||Notification.permission==='granted'?'disabled':''}>${esc(notifState)}</button></div></div>
      <div class="attAlertStats"><div class="attAlertStat"><strong>${visible.length}</strong><span>Active alerts</span></div><div class="attAlertStat"><strong>${high}</strong><span>High priority</span></div><div class="attAlertStat"><strong>${late}</strong><span>Late arrivals</span></div><div class="attAlertStat"><strong>${devices}</strong><span>Tablet alerts</span></div></div>
      <div class="attAlertList">${visible.length ? visible.map(a=>`<div class="attAlert ${a.severity}"><div><h3>${esc(a.title)}</h3><p>${esc(a.detail)}</p><div class="attAlertMeta">${esc(a.type)}</div></div><div class="attAlertSide"><b class="attSeverity ${a.severity}">${a.severity.toUpperCase()}</b><button class="attAck" data-ack="${esc(a.key)}">Acknowledge</button></div></div>`).join('') : '<div class="attAlertEmpty">No active attendance or device alerts right now.</div>'}</div>`;
    panel.querySelector('#att-enable-notifications')?.addEventListener('click', async () => { try { await Notification.requestPermission(); refresh(); } catch {} });
    panel.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => { saveAck(b.getAttribute('data-ack')); refresh(); }));
  };

  async function refresh(){
    if (loading) return; const host = findHost();
    if (!host) { document.getElementById('attendra-alerts-center')?.remove(); return; }
    const auth = tokenInfo(); if (!auth) return; loading = true;
    let panel = document.getElementById('attendra-alerts-center'); if (!panel) { panel = document.createElement('section'); panel.id='attendra-alerts-center'; panel.className='attAlerts'; host.insertAdjacentElement('afterend', panel); }
    try {
      const range = localDayRange();
      const [timeData, deviceData] = await Promise.all([api(`/v1/admin/timesheets?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, auth.token), api('/v1/admin/devices', auth.token)]);
      const alerts = makeAlerts(timeData.entries || [], deviceData.devices || []); notifyNew(alerts); render(panel, alerts);
    } catch { panel.innerHTML = '<div class="attAlertsHead"><div><h2>Alerts & notifications</h2><span>Unable to refresh alerts right now.</span></div></div>'; }
    finally { loading = false; }
  }

  const observer = new MutationObserver(() => { if (findHost()) refresh(); else document.getElementById('attendra-alerts-center')?.remove(); });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  setInterval(refresh, REFRESH_MS); window.addEventListener('focus', refresh); setTimeout(refresh, 1200);
})();
