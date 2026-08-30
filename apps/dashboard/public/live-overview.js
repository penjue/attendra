(() => {
  const API_URL = 'https://attendra-api.onrender.com';
  const REFRESH_MS = 5000;
  let timer = null;
  let loading = false;
  let selectedDetail = null;

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
    .hqPerson{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid #eef2f7;cursor:pointer;border-radius:10px}
    .hqPerson:hover{background:#f8fafc}.hqPerson:first-of-type{border-top:0}.hqPerson strong,.hqPerson span{display:block}.hqPerson span{color:#64748b;font-size:12px;margin-top:3px;line-height:1.35}
    .hqChip{align-self:flex-start;border-radius:999px;padding:4px 7px;font-size:10px;font-weight:700;white-space:nowrap;background:#f1f5f9;color:#475569}
    .hqChip.working{background:#ecfdf5;color:#047857}.hqChip.late{background:#fef2f2;color:#b91c1c}.hqChip.missing{background:#fff7ed;color:#c2410c}.hqChip.out{background:#eff6ff;color:#1d4ed8}.hqChip.offline{background:#fef2f2;color:#b91c1c}
    .hqLiveError{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:10px 12px;font-size:13px}
    .hqDetailBackdrop{position:fixed;inset:0;background:rgba(15,23,42,.38);display:grid;place-items:end center;z-index:9999;padding:18px}
    .hqDetailCard{width:min(100%,560px);background:#fff;border-radius:20px;padding:20px;border:1px solid #e2e8f0;box-shadow:0 24px 60px rgba(15,23,42,.22);max-height:85vh;overflow:auto}
    .hqDetailHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}.hqDetailHead h3{margin:0}.hqDetailHead span{display:block;color:#64748b;font-size:13px;margin-top:4px}
    .hqDetailClose{border:1px solid #cbd5e1;background:#fff;border-radius:10px;padding:8px 11px;cursor:pointer}.hqDetailGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .hqDetailMetric{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px}.hqDetailMetric small{display:block;color:#64748b;margin-bottom:4px}.hqDetailMetric strong{font-size:14px}
    .hqDetailNote{margin:14px 0 0;padding:12px;border-radius:12px;background:#f8fafc;color:#475569;font-size:13px;line-height:1.45}
    @media(max-width:720px){.hqLiveStats{grid-template-columns:repeat(2,1fr)}.hqLiveColumns{grid-template-columns:1fr}.hqLiveHead{flex-direction:column}.hqPerson{align-items:flex-start}.hqDetailGrid{grid-template-columns:1fr 1fr}}
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
  const time = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  const dateTime = value => value ? new Date(value).toLocaleString() : '—';
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  const findHost = () => {
    const active = [...document.querySelectorAll('.tabs button')].find(b => b.classList.contains('active'));
    if (!active || active.textContent.trim() !== 'Overview') return null;
    const shell = document.querySelector('.shell');
    if (!shell) return null;
    return shell.querySelector('.grid');
  };

  const eventForShift = (events, shift) => {
    const start = new Date(shift.startsAt).getTime() - 4 * 60 * 60 * 1000;
    const end = new Date(shift.endsAt).getTime() + 4 * 60 * 60 * 1000;
    return events
      .filter(e => e.employeeNumber === shift.employeeNumber && e.branchName === shift.branchName)
      .filter(e => { const t = new Date(e.occurredAt).getTime(); return t >= start && t <= end; })
      .sort((a,b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0] || null;
  };

  const encodeDetail = item => encodeURIComponent(JSON.stringify(item));
  const renderPerson = (item, kind) => {
    const labels = { working: 'ON SITE', late: 'LATE', missing: 'NOT ARRIVED', out: 'CHECKED OUT' };
    return `<div class="hqPerson" data-live-detail="${encodeDetail(item)}"><div><strong>${esc(item.employeeName)}</strong><span>#${esc(item.employeeNumber)} · ${esc(item.branchName)}</span><span>${esc(item.detail)}</span></div><b class="hqChip ${kind}">${labels[kind]}</b></div>`;
  };

  const renderDevice = device => {
    const detail = { type:'device', title:device.name, branchName:device.branchName, online:device.online, lastSeenAt:device.lastSeenAt, active:device.active };
    return `<div class="hqPerson" data-live-detail="${encodeDetail(detail)}"><div><strong>${esc(device.name)}</strong><span>${esc(device.branchName)}</span><span>${device.lastSeenAt ? `Last seen ${esc(dateTime(device.lastSeenAt))}` : 'Never seen'}</span></div><b class="hqChip ${device.online ? 'working' : 'offline'}">${device.online ? 'ONLINE' : 'OFFLINE'}</b></div>`;
  };

  const showDetail = detail => {
    selectedDetail = detail;
    document.getElementById('hq-live-detail')?.remove();
    const backdrop = document.createElement('div');
    backdrop.id = 'hq-live-detail';
    backdrop.className = 'hqDetailBackdrop';
    const employeeMode = detail.type !== 'device';
    const statusText = detail.type === 'working' ? (detail.late ? 'Late & on site' : 'On site') : detail.type === 'missing' ? 'Not arrived' : detail.type === 'out' ? 'Checked out' : detail.online ? 'Online' : 'Offline';
    backdrop.innerHTML = `<div class="hqDetailCard"><div class="hqDetailHead"><div><h3>${esc(employeeMode ? detail.employeeName : detail.title)}</h3><span>${esc(employeeMode ? `#${detail.employeeNumber} · ${detail.branchName}` : detail.branchName)}</span></div><button class="hqDetailClose" type="button">Close</button></div>
      <div class="hqDetailGrid">
        <div class="hqDetailMetric"><small>Status</small><strong>${esc(statusText)}</strong></div>
        ${employeeMode ? `<div class="hqDetailMetric"><small>Branch</small><strong>${esc(detail.branchName)}</strong></div>
        <div class="hqDetailMetric"><small>Scheduled start</small><strong>${time(detail.startsAt)}</strong></div>
        <div class="hqDetailMetric"><small>Scheduled end</small><strong>${time(detail.endsAt)}</strong></div>
        <div class="hqDetailMetric"><small>Check in</small><strong>${time(detail.checkInAt)}</strong></div>
        <div class="hqDetailMetric"><small>Check out</small><strong>${time(detail.checkOutAt)}</strong></div>` : `<div class="hqDetailMetric"><small>Active</small><strong>${detail.active ? 'Yes' : 'No'}</strong></div><div class="hqDetailMetric"><small>Last heartbeat</small><strong>${esc(dateTime(detail.lastSeenAt))}</strong></div>`}
      </div>
      <p class="hqDetailNote">${esc(detail.detail || (employeeMode ? 'Live attendance and shift information for this employee.' : 'Tablet connectivity is updated by the automatic heartbeat while the tablet page is open.'))}</p></div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector('.hqDetailClose')?.addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); });
  };

  const attachDetailHandlers = panel => {
    panel.querySelectorAll('[data-live-detail]').forEach(el => el.addEventListener('click', () => {
      try { showDetail(JSON.parse(decodeURIComponent(el.getAttribute('data-live-detail')))); } catch {}
    }));
  };

  const refresh = async () => {
    if (loading) return;
    const host = findHost();
    if (!host) { document.getElementById('hq-live-overview')?.remove(); document.getElementById('hq-live-detail')?.remove(); return; }
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
          working.push({ type:'working', ...shift, checkInAt:latest.occurredAt, checkOutAt:null, detail: `Checked in ${time(latest.occurredAt)} · shift ends ${time(shift.endsAt)}`, late: latest.status === 'LATE' });
        } else if (nowMs > startMs + 5 * 60 * 1000) {
          missing.push({ type:'missing', ...shift, checkInAt:null, checkOutAt:null, detail: `Shift started ${time(shift.startsAt)} · ${Math.max(0, Math.floor((nowMs-startMs)/60000))} min overdue` });
        }
      }
      const latestByEmployee = new Map();
      for (const event of eventData.events) {
        const key = `${event.employeeNumber}|${event.branchName}`;
        if (!latestByEmployee.has(key)) latestByEmployee.set(key, event);
      }
      const checkedOut = [...latestByEmployee.values()].filter(e => e.action === 'CHECK_OUT' && sameDay(new Date(e.occurredAt), now)).slice(0, 8).map(e => {
        const shift = shiftData.shifts.find(s => s.employeeNumber === e.employeeNumber && s.branchName === e.branchName && sameDay(new Date(s.startsAt), new Date(e.occurredAt)));
        return { type:'out', ...e, startsAt:shift?.startsAt ?? null, endsAt:shift?.endsAt ?? null, checkInAt:null, checkOutAt:e.occurredAt, detail: `Checked out ${time(e.occurredAt)}` };
      });
      const activeDevices = deviceData.devices.filter(d => d.active);
      const onlineDevices = activeDevices.filter(d => d.online);
      const lateWorking = working.filter(w => w.late).length;

      panel.innerHTML = `<div class="hqLiveHead"><div><h2>HQ live status</h2><span>Tap a person or tablet for operational details.</span></div><b class="hqPulse">LIVE · 5 SEC</b></div>
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
          <div class="hqLiveGroup"><h3>Tablet health</h3>${activeDevices.length ? activeDevices.map(renderDevice).join('') : '<p class="hqLiveEmpty">No registered tablets.</p>'}</div>
        </div>`;
      attachDetailHandlers(panel);
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
