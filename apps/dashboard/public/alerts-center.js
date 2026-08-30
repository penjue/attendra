(() => {
  const API_URL = 'https://attendra-api.onrender.com';
  const REFRESH_MS = 15000;
  const RECENT_DEVICE_MS = 3 * 60 * 1000;
  const ACK_KEY = 'attendra_hq_ack_alerts_v2';
  let loading = false;
  let lastAlertKeys = new Set();

  const style = document.createElement('style');
  style.textContent = `
    .attAlerts{margin:20px auto 0;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px;max-width:100%}
    .attAlertsHead{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:14px}
    .attAlertsHead h2{margin:0}.attAlertsHead span{display:block;color:#64748b;font-size:13px;margin-top:4px;line-height:1.4}
    .attAlertBtn{border:1px solid #cbd5e1;background:#0f172a;color:#fff;border-radius:10px;padding:8px 11px;cursor:pointer;font:inherit}.attAlertBtn:disabled{opacity:.55;cursor:not-allowed}
    .attAlertStats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}
    .attAlertStat{border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:#f8fafc}.attAlertStat strong{display:block;font-size:22px}.attAlertStat span{display:block;color:#64748b;font-size:12px;margin-top:3px}
    .attAlertList{display:grid;gap:10px}.attAlert{display:flex;justify-content:space-between;gap:12px;border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:#fff}
    .attAlert.high{border-color:#fecaca;background:#fff7f7}.attAlert.medium{border-color:#fed7aa;background:#fffaf5}
    .attAlert h3{font-size:14px;margin:0}.attAlert p{font-size:12px;color:#64748b;margin:4px 0 0;line-height:1.45}.attAlertMeta{font-size:11px;color:#64748b;margin-top:5px}
    .attAlertSide{display:flex;flex-direction:column;align-items:flex-end;gap:8px}.attSeverity{border-radius:999px;padding:4px 7px;font-size:10px;font-weight:700;white-space:nowrap}
    .attSeverity.high{background:#fef2f2;color:#b91c1c}.attSeverity.medium{background:#fff7ed;color:#c2410c}.attAck{border:1px solid #cbd5e1;background:#fff;border-radius:9px;padding:6px 8px;font-size:11px;cursor:pointer}
    .attAlertEmpty{color:#64748b;font-size:13px;padding:10px 0}.attAlertError{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:10px 12px;font-size:13px}
    @media(max-width:720px){.attAlertsHead{flex-direction:column}.attAlertStats{grid-template-columns:repeat(2,1fr)}.attAlert{align-items:flex-start}.attAlertSide{min-width:86px}}
  `;
  document.head.appendChild(style);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt = value => value ? new Date(value).toLocaleString() : '—';
  const fmtTime = value => value ? new Date(value).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—';

  function getAuth(){
    const token = sessionStorage.getItem('attendra_admin_token');
    if (!token) return null;
    try {
      const parts = token.split('.');
      const raw = parts.length > 1 ? parts[1] : parts[0];
      const padded = raw.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((raw.length + 3) % 4);
      const json = JSON.parse(atob(padded));
      return { token, companyId: json.companyId };
    } catch {
      try {
        const raw = token.split('.')[0];
        const json = JSON.parse(atob(raw.replace(/-/g,'+').replace(/_/g,'/')));
        return { token, companyId: json.companyId };
      } catch { return null; }
    }
  }

  async function api(path, token){
    const response = await fetch(`${API_URL}${path}`, {headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  }

  function isOverview(){
    const active = [...document.querySelectorAll('.tabs button')].find(b => b.classList.contains('active'));
    return !!active && active.textContent.trim() === 'Overview';
  }

  function ensurePanel(){
    if (!isOverview()) return null;
    let panel = document.getElementById('attendra-alerts-center');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'attendra-alerts-center';
    panel.className = 'attAlerts';
    const live = document.getElementById('hq-live-overview');
    if (live) live.insertAdjacentElement('afterend', panel);
    else {
      const shell = document.querySelector('.shell');
      if (!shell) return null;
      shell.appendChild(panel);
    }
    return panel;
  }

  function acked(){
    try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveAck(key){
    const set = acked(); set.add(key);
    localStorage.setItem(ACK_KEY, JSON.stringify([...set].slice(-300)));
  }

  function eventForShift(events, shift){
    const start = new Date(shift.startsAt).getTime() - 4 * 60 * 60 * 1000;
    const end = new Date(shift.endsAt).getTime() + 4 * 60 * 60 * 1000;
    return events.filter(e => e.employeeNumber === shift.employeeNumber && e.branchName === shift.branchName)
      .filter(e => { const t = new Date(e.occurredAt).getTime(); return t >= start && t <= end; })
      .sort((a,b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  }

  function makeAlerts(shifts, events, devices){
    const now = Date.now();
    const alerts = [];

    for (const shift of shifts) {
      const start = new Date(shift.startsAt).getTime();
      const end = new Date(shift.endsAt).getTime();
      if (start > now) continue;
      const related = eventForShift(events, shift);
      const checkIn = related.find(e => e.action === 'CHECK_IN');
      const checkOut = checkIn ? related.find(e => e.action === 'CHECK_OUT' && new Date(e.occurredAt) >= new Date(checkIn.occurredAt)) : null;

      if (!checkIn && now > start + 5 * 60000 && now <= end + 12 * 60 * 60000) {
        alerts.push({key:`missed:${shift.id}`,severity:'high',type:'Missed shift',title:`${shift.employeeName} has not arrived`,detail:`${shift.branchName} · shift started ${fmtTime(shift.startsAt)}`});
      }
      if (checkIn && !checkOut && now > end + 15 * 60000) {
        alerts.push({key:`checkout:${shift.id}`,severity:'high',type:'Missing checkout',title:`${shift.employeeName} is still clocked in`,detail:`${shift.branchName} · shift ended ${fmtTime(shift.endsAt)}`});
      }
      if (checkIn && new Date(checkIn.occurredAt).getTime() > start + 5 * 60000) {
        const mins = Math.max(1, Math.round((new Date(checkIn.occurredAt).getTime() - start) / 60000));
        alerts.push({key:`late:${shift.id}:${checkIn.occurredAt}`,severity:'medium',type:'Late arrival',title:`${shift.employeeName} arrived late`,detail:`${shift.branchName} · ${mins} min after shift start`});
      }
    }

    for (const device of devices.filter(d => d.active)) {
      if (device.online) continue;
      const last = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
      if (last && now - last <= RECENT_DEVICE_MS) {
        alerts.push({key:`device-recent:${device.id}:${device.lastSeenAt}`,severity:'medium',type:'Tablet connection',title:`${device.name} recently disconnected`,detail:`${device.branchName} · last heartbeat ${fmt(device.lastSeenAt)}`});
      } else {
        alerts.push({key:`device-offline:${device.id}`,severity:'high',type:'Tablet offline',title:`${device.name} is offline`,detail:`${device.branchName} · ${device.lastSeenAt ? `last heartbeat ${fmt(device.lastSeenAt)}` : 'no heartbeat recorded'}`});
      }
    }
    return alerts;
  }

  function notifyNew(alerts){
    const current = new Set(alerts.map(a => a.key));
    if ('Notification' in window && Notification.permission === 'granted') {
      alerts.filter(a => a.severity === 'high' && !lastAlertKeys.has(a.key)).forEach(a => {
        try { new Notification(`Attendra: ${a.type}`, {body:`${a.title}. ${a.detail}`, tag:a.key}); } catch {}
      });
    }
    lastAlertKeys = current;
  }

  function render(panel, alerts){
    const dismissed = acked();
    const visible = alerts.filter(a => !dismissed.has(a.key));
    const high = visible.filter(a => a.severity === 'high').length;
    const late = visible.filter(a => a.type === 'Late arrival').length;
    const tablets = visible.filter(a => a.type.startsWith('Tablet')).length;
    const notifSupported = 'Notification' in window;
    const notifLabel = !notifSupported ? 'Browser alerts unsupported' : Notification.permission === 'granted' ? 'Browser alerts on' : 'Enable browser alerts';

    panel.innerHTML = `<div class="attAlertsHead"><div><h2>Alerts & notifications</h2><span>Late arrivals, missed shifts, missing check-outs and tablet connection problems.</span></div><button class="attAlertBtn" id="att-enable-notifications" ${!notifSupported || Notification.permission === 'granted' ? 'disabled' : ''}>${esc(notifLabel)}</button></div>
      <div class="attAlertStats"><div class="attAlertStat"><strong>${visible.length}</strong><span>Active alerts</span></div><div class="attAlertStat"><strong>${high}</strong><span>High priority</span></div><div class="attAlertStat"><strong>${late}</strong><span>Late arrivals</span></div><div class="attAlertStat"><strong>${tablets}</strong><span>Tablet alerts</span></div></div>
      <div class="attAlertList">${visible.length ? visible.map(a => `<div class="attAlert ${a.severity}"><div><h3>${esc(a.title)}</h3><p>${esc(a.detail)}</p><div class="attAlertMeta">${esc(a.type)}</div></div><div class="attAlertSide"><b class="attSeverity ${a.severity}">${a.severity.toUpperCase()}</b><button class="attAck" data-ack="${esc(a.key)}">Acknowledge</button></div></div>`).join('') : '<div class="attAlertEmpty">No active attendance or device alerts right now.</div>'}</div>`;

    panel.querySelector('#att-enable-notifications')?.addEventListener('click', async () => {
      try { await Notification.requestPermission(); refresh(); } catch {}
    });
    panel.querySelectorAll('[data-ack]').forEach(button => button.addEventListener('click', () => {
      saveAck(button.getAttribute('data-ack')); refresh();
    }));
  }

  async function refresh(){
    if (loading) return;
    if (!isOverview()) { document.getElementById('attendra-alerts-center')?.remove(); return; }
    const panel = ensurePanel();
    const auth = getAuth();
    if (!panel || !auth?.token || !auth?.companyId) return;
    loading = true;
    try {
      const [shiftData, eventData, deviceData] = await Promise.all([
        api('/v1/admin/shifts', auth.token),
        api(`/v1/companies/${encodeURIComponent(auth.companyId)}/attendance/recent`, auth.token),
        api('/v1/admin/devices', auth.token)
      ]);
      const alerts = makeAlerts(shiftData.shifts || [], eventData.events || [], deviceData.devices || []);
      notifyNew(alerts);
      render(panel, alerts);
    } catch (error) {
      panel.innerHTML = '<div class="attAlertsHead"><div><h2>Alerts & notifications</h2><span>Operational exceptions that need management attention.</span></div></div><div class="attAlertError">Unable to refresh alerts right now.</div>';
    } finally { loading = false; }
  }

  new MutationObserver(() => {
    if (isOverview()) ensurePanel();
    else document.getElementById('attendra-alerts-center')?.remove();
  }).observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['class']});

  setInterval(refresh, REFRESH_MS);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setTimeout(refresh, 800);
})();
