(() => {
  const API_URL = 'https://attendra-api.onrender.com';
  const REFRESH_MS = 5000;
  let timer = null;
  let loading = false;

  const styles = `
    .hqLivePanel{margin-top:20px;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px}
    .hqLiveHead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}
    .hqLiveHead h2{margin:0}.hqLiveHead span{display:block;color:#64748b;margin-top:4px;font-size:13px}
    .hqPulse{font-size:12px;font-weight:700;padding:6px 9px;border-radius:999px;background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;white-space:nowrap}
    .hqLiveStats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
    .hqLiveStat{border:1px solid #e2e8f0;border-radius:14px;padding:14px;background:#f8fafc}
    .hqLiveStat strong{display:block;font-size:24px}.hqLiveStat span{display:block;color:#64748b;font-size:12px;margin-top:3px}
    .hqLiveColumns{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .hqLiveGroup{border:1px solid #e2e8f0;border-radius:14px;padding:14px;min-width:0}
    .hqLiveGroup h3{font-size:15px;margin:0 0 8px}.hqLiveEmpty{color:#64748b;font-size:13px;margin:8px 0}
    .hqPerson{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid #eef2f7}
    .hqPerson:first-of-type{border-top:0}.hqPerson strong,.hqPerson span{display:block}.hqPerson span{color:#64748b;font-size:12px;margin-top:3px;line-height:1.35}
    .hqChip{align-self:flex-start;border-radius:999px;padding:4px 7px;font-size:10px;font-weight:700;white-space:nowrap;background:#f1f5f9;color:#475569}
    .hqChip.working{background:#ecfdf5;color:#047857}.hqChip.late{background:#fef2f2;color:#b91c1c}.hqChip.missing{background:#fff7ed;color:#c2410c}.hqChip.out{background:#eff6ff;color:#1d4ed8}.hqChip.offline{background:#fef2f2;color:#b91c1c}
    .hqLiveError{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:10px 12px;font-size:13px}
    @media(max-width:720px){.hqLiveStats{grid-template-columns:repeat(2,1fr)}.hqLiveColumns{grid-template-columns:1fr}.hqLiveHead{flex-direction:column}.hqPerson{align-items:flex-start}}
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);

  const tokenInfo = () => {
    const token = sessionStorage.getItem('attendra_admin_token');
    if (!token) return null;
    try {
      const body = token.split('.')[0];
      const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
      return { token, companyId: json.companyId };
    } catch { return null; }
  };

  const api = async (path, token) => {
    const response = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error('LIVE_STATUS_FAILED');
    return response.json();
  };

  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  const findHost = () => {
    const active = [...document.querySelectorAll('.tabs button')].find(b => b.classList.contains('active'));
    if (!active || active.textContent.trim() !== 'Overview') return null;
    const shell = document.querySelector('.shell');
    if (!shell) return null;
    const grid = shell.querySelector('.grid');
    if (!grid) return null;
    return grid;
  };

  const eventForShift = (events, shift) => {
    const start = new Date(shift.startsAt).getTime() - 4 * 60 * 60 * 1000;
    const end = new Date(shift.endsAt).getTime() + 4 * 60 * 60 * 1000;
    return events
      .filter(e => e.employeeNumber === shift.employeeNumber && e.branchName === shift.branchName)
      .filter(e => { const t = new Date(e.occurredAt).getTime(); return t >= start && t <= end; })
      .sort((a,b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0] || null;
  };

  const renderPerson = (item, kind) => {
    const labels = { working: 'ON SITE', late: 'LATE', missing: 'NOT ARRIVED', out: 'CHECKED OUT' };
    return `<div class="hqPerson"><div><strong>${esc(item.employeeName)}</strong><span>#${esc(item.employeeNumber)} · ${esc(item.branchName)}</span><span>${esc(item.detail)}</span></div><b class="hqChip ${kind}">${labels[kind]}</b></div>`;
  };

  const refresh = async () => {
    if (loading) return;
    const host = findHost();
    if (!host) { document.getElementById('hq-live-overview')?.remove(); return; }
    const auth = tokenInfo();
    if (!auth?.companyId) return;
    loading = true;
    let panel = document.getElementById('hq-live-overview');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'hq-live-overview';
      panel.className = 'hqLivePanel';
      host.insertAdjacentElement('afterend', panel);
    }
    try {
      const [shiftData, eventData, deviceData] = await Promise.all([
        api('/v1/admin/shifts', auth.token),
        api(`/v1/companies/${encodeURIComponent(auth.companyId)}/attendance/recent`, auth.token),
        api('/v1/admin/devices', auth.token)
      ]);
      const now = new Date();
      const nowMs = now.getTime();
      const currentShifts = shiftData.shifts.filter(s => new Date(s.startsAt).getTime() <= nowMs && new Date(s.endsAt).getTime() >= nowMs);
      const working = [], missing = [];
      for (const shift of currentShifts) {
        const latest = eventForShift(eventData.events, shift);
        const startMs = new Date(shift.startsAt).getTime();
        if (latest?.action === 'CHECK_IN') {
          working.push({ ...shift, detail: `Checked in ${time(latest.occurredAt)} · shift ends ${time(shift.endsAt)}`, late: latest.status === 'LATE' });
        } else if (nowMs > startMs + 5 * 60 * 1000) {
          missing.push({ ...shift, detail: `Shift started ${time(shift.startsAt)} · ${Math.max(0, Math.floor((nowMs-startMs)/60000))} min overdue` });
        }
      }
      const latestByEmployee = new Map();
      for (const event of eventData.events) {
        const key = `${event.employeeNumber}|${event.branchName}`;
        if (!latestByEmployee.has(key)) latestByEmployee.set(key, event);
      }
      const checkedOut = [...latestByEmployee.values()].filter(e => e.action === 'CHECK_OUT' && sameDay(new Date(e.occurredAt), now)).slice(0, 8).map(e => ({ ...e, detail: `Checked out ${time(e.occurredAt)}` }));
      const activeDevices = deviceData.devices.filter(d => d.active);
      const onlineDevices = activeDevices.filter(d => d.online);
      const offlineDevices = activeDevices.filter(d => !d.online);
      const lateWorking = working.filter(w => w.late).length;

      panel.innerHTML = `<div class="hqLiveHead"><div><h2>HQ live status</h2><span>Who is working, missing, checked out and whether branch tablets are online.</span></div><b class="hqPulse">LIVE · 5 SEC</b></div>
        <div class="hqLiveStats">
          <div class="hqLiveStat"><strong>${working.length}</strong><span>Working now</span></div>
          <div class="hqLiveStat"><strong>${lateWorking}</strong><span>Late & on site</span></div>
          <div class="hqLiveStat"><strong>${missing.length}</strong><span>Not arrived</span></div>
          <div class="hqLiveStat"><strong>${onlineDevices.length}/${activeDevices.length}</strong><span>Tablets online</span></div>
        </div>
        <div class="hqLiveColumns">
          <div class="hqLiveGroup"><h3>Currently working</h3>${working.length ? working.map(w => renderPerson(w, w.late ? 'late' : 'working')).join('') : '<p class="hqLiveEmpty">No employees are currently checked in.</p>'}</div>
          <div class="hqLiveGroup"><h3>Not arrived</h3>${missing.length ? missing.map(m => renderPerson(m, 'missing')).join('') : '<p class="hqLiveEmpty">No overdue scheduled arrivals.</p>'}</div>
          <div class="hqLiveGroup"><h3>Checked out today</h3>${checkedOut.length ? checkedOut.map(o => renderPerson(o, 'out')).join('') : '<p class="hqLiveEmpty">No check-outs recorded today.</p>'}</div>
          <div class="hqLiveGroup"><h3>Tablet health</h3>${activeDevices.length ? activeDevices.map(d => `<div class="hqPerson"><div><strong>${esc(d.name)}</strong><span>${esc(d.branchName)}</span><span>${d.lastSeenAt ? `Last seen ${esc(new Date(d.lastSeenAt).toLocaleString())}` : 'Never seen'}</span></div><b class="hqChip ${d.online ? 'working' : 'offline'}">${d.online ? 'ONLINE' : 'OFFLINE'}</b></div>`).join('') : '<p class="hqLiveEmpty">No registered tablets.</p>'}</div>
        </div>`;
    } catch {
      panel.innerHTML = '<div class="hqLiveHead"><div><h2>HQ live status</h2><span>Live workforce monitoring</span></div></div><div class="hqLiveError">Unable to refresh live workforce status. The normal dashboard remains available.</div>';
    } finally { loading = false; }
  };

  const observer = new MutationObserver(() => { if (findHost()) refresh(); else document.getElementById('hq-live-overview')?.remove(); });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  timer = setInterval(refresh, REFRESH_MS);
  window.addEventListener('focus', refresh);
  setTimeout(refresh, 500);
})();
