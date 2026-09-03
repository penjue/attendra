(() => {
  const API_URL = 'https://attendra-api.onrender.com';
  const REFRESH_MS = 15000;
  const ACK_KEY = 'attendra_hq_ack_alerts_v3';
  const RULES_KEY = 'attendra_hq_escalation_rules_v1';
  const DEFAULT_RULES = {
    lateAfterMinutes: 5,
    missedShiftAfterMinutes: 10,
    missingCheckoutAfterMinutes: 15,
    tabletOfflineAfterMinutes: 3,
    notifyHighPriority: true,
    notifyMediumPriority: false
  };
  let loading = false;
  let lastAlertKeys = new Set();
  let settingsOpen = false;

  const style = document.createElement('style');
  style.textContent = `
    .attAlerts{margin:20px auto 0;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px;max-width:100%}
    .attAlertsHead{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:14px}.attAlertsHead h2{margin:0}.attAlertsHead span{display:block;color:#64748b;font-size:13px;margin-top:4px;line-height:1.4}
    .attAlertActions{display:flex;gap:8px;flex-wrap:wrap}.attAlertBtn{border:1px solid #cbd5e1;background:#0f172a;color:#fff;border-radius:10px;padding:8px 11px;cursor:pointer;font:inherit}.attAlertBtn.secondary{background:#fff;color:#0f172a}.attAlertBtn:disabled{opacity:.55}
    .attAlertStats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.attAlertStat{border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:#f8fafc}.attAlertStat strong{display:block;font-size:22px}.attAlertStat span{display:block;color:#64748b;font-size:12px;margin-top:3px}
    .attRules{margin:12px 0 16px;border:1px solid #dbe3ed;border-radius:14px;padding:14px;background:#f8fafc}.attRules h3{margin:0 0 4px;font-size:16px}.attRules>p{margin:0 0 12px;color:#64748b;font-size:12px;line-height:1.45}.attRuleGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.attRuleField{display:grid;gap:5px}.attRuleField label{font-size:12px;color:#475569}.attRuleField input[type=number]{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;background:#fff;border-radius:10px;padding:10px;font:inherit}.attRuleChecks{display:grid;gap:8px;margin-top:12px}.attRuleCheck{display:flex;align-items:center;gap:8px;font-size:12px;color:#475569}.attRuleFooter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}.attRuleSaved{font-size:12px;color:#047857}
    .attAlertList{display:grid;gap:10px}.attAlert{display:flex;justify-content:space-between;gap:12px;border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:#fff}.attAlert.high{border-color:#fecaca;background:#fff7f7}.attAlert.medium{border-color:#fed7aa;background:#fffaf5}.attAlert.acknowledged{opacity:.7;background:#f8fafc;border-color:#e2e8f0}.attAlert h3{font-size:14px;margin:0}.attAlert p{font-size:12px;color:#64748b;margin:4px 0 0;line-height:1.45}.attAlertMeta{font-size:11px;color:#64748b;margin-top:5px}.attAlertSide{display:flex;flex-direction:column;align-items:flex-end;gap:8px}.attSeverity{border-radius:999px;padding:4px 7px;font-size:10px;font-weight:700;white-space:nowrap}.attSeverity.high{background:#fef2f2;color:#b91c1c}.attSeverity.medium{background:#fff7ed;color:#c2410c}.attSeverity.ack{background:#f1f5f9;color:#475569}.attAck{border:1px solid #cbd5e1;background:#fff;border-radius:9px;padding:6px 8px;font-size:11px;cursor:pointer}.attAlertEmpty{color:#64748b;font-size:13px;padding:10px 0}.attAlertError{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:10px 12px;font-size:13px}
    @media(max-width:720px){.attAlertsHead{flex-direction:column}.attAlertStats,.attRuleGrid{grid-template-columns:repeat(2,1fr)}.attAlert{align-items:flex-start}.attAlertSide{min-width:86px}}
  `;
  document.head.appendChild(style);

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => v ? new Date(v).toLocaleString() : '—';
  const fmtTime = v => v ? new Date(v).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

  function getRules(){
    try { return {...DEFAULT_RULES, ...JSON.parse(localStorage.getItem(RULES_KEY) || '{}')}; }
    catch { return {...DEFAULT_RULES}; }
  }
  function saveRules(rules){ localStorage.setItem(RULES_KEY, JSON.stringify(rules)); }

  function getAuth(){
    const token = sessionStorage.getItem('attendra_admin_token');
    if (!token) return null;
    for (const raw0 of [token.split('.')[1], token.split('.')[0]]) {
      if (!raw0) continue;
      try {
        const raw = raw0.replace(/-/g,'+').replace(/_/g,'/');
        const json = JSON.parse(atob(raw + '==='.slice((raw.length + 3) % 4)));
        return {token, companyId: json.companyId};
      } catch {}
    }
    return null;
  }

  async function api(path, token){
    const r = await fetch(`${API_URL}${path}`, {headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
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
    else document.querySelector('.shell')?.appendChild(panel);
    return panel;
  }

  const acked = () => { try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || '[]')); } catch { return new Set(); } };
  const saveAck = key => { const set = acked(); set.add(key); localStorage.setItem(ACK_KEY, JSON.stringify([...set].slice(-300))); };
  const reopen = key => { const set = acked(); set.delete(key); localStorage.setItem(ACK_KEY, JSON.stringify([...set])); };

  function eventForShift(events, shift){
    return events.filter(e => e.shiftId && e.shiftId === shift.id).sort((a,b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  }

  function makeAlerts(shifts, events, devices, rules){
    const now = Date.now();
    const alerts = [];
    for (const shift of shifts) {
      const start = new Date(shift.startsAt).getTime();
      const end = new Date(shift.endsAt).getTime();
      if (start > now) continue;
      const related = eventForShift(events, shift);
      const checkIn = related.find(e => e.action === 'CHECK_IN');
      const checkOut = checkIn ? related.find(e => e.action === 'CHECK_OUT' && new Date(e.occurredAt) >= new Date(checkIn.occurredAt)) : null;

      if (!checkIn && now > start + rules.missedShiftAfterMinutes * 60000 && now <= end + 12 * 60 * 60000) {
        alerts.push({key:`missed:${shift.id}`, severity:'high', type:'Missed shift', title:`${shift.employeeName} has not arrived`, detail:`${shift.branchName} · ${Math.floor((now-start)/60000)} min after shift start`});
      }
      if (checkIn && !checkOut && now > end + rules.missingCheckoutAfterMinutes * 60000) {
        alerts.push({key:`checkout:${shift.id}`, severity:'high', type:'Missing checkout', title:`${shift.employeeName} is still clocked in`, detail:`${shift.branchName} · shift ended ${fmtTime(shift.endsAt)}`});
      }
      if (checkIn) {
        const lateMinutes = Math.max(0, Math.round((new Date(checkIn.occurredAt).getTime() - start) / 60000));
        if (lateMinutes > rules.lateAfterMinutes) {
          alerts.push({key:`late:${shift.id}:${checkIn.occurredAt}`, severity:'medium', type:'Late arrival', title:`${shift.employeeName} arrived late`, detail:`${shift.branchName} · ${lateMinutes} min after shift start · alert threshold ${rules.lateAfterMinutes} min`});
        }
      }
    }

    for (const d of devices.filter(x => x.active)) {
      const last = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
      const offlineFor = last ? Math.max(0, Math.floor((now - last) / 60000)) : null;
      if (last && now - last <= rules.tabletOfflineAfterMinutes * 60000) continue;
      alerts.push({
        key:`device-offline:${d.id}:${d.lastSeenAt || 'never'}`,
        severity:'high',
        type:'Tablet offline',
        title:`${d.name} is offline`,
        detail:`${d.branchName} · ${offlineFor === null ? 'no heartbeat recorded' : `${offlineFor} min since last heartbeat`}`
      });
    }
    return alerts;
  }

  function notifyNew(alerts, rules){
    const current = new Set(alerts.map(a => a.key));
    if ('Notification' in window && Notification.permission === 'granted') {
      alerts.filter(a => !lastAlertKeys.has(a.key) && ((a.severity === 'high' && rules.notifyHighPriority) || (a.severity === 'medium' && rules.notifyMediumPriority))).forEach(a => {
        try { new Notification(`Attendra: ${a.type}`, {body:`${a.title}. ${a.detail}`, tag:a.key}); } catch {}
      });
    }
    lastAlertKeys = current;
  }

  function rulesMarkup(rules){
    if (!settingsOpen) return '';
    return `<div class="attRules">
      <h3>Management escalation rules</h3>
      <p>Choose when Attendra should raise operational alerts. Changes apply immediately on this HQ dashboard.</p>
      <div class="attRuleGrid">
        <div class="attRuleField"><label for="att-rule-late">Late arrival alert after</label><input id="att-rule-late" type="number" min="0" max="180" value="${rules.lateAfterMinutes}"><small>minutes after shift start</small></div>
        <div class="attRuleField"><label for="att-rule-missed">Missed shift alert after</label><input id="att-rule-missed" type="number" min="1" max="180" value="${rules.missedShiftAfterMinutes}"><small>minutes with no check-in</small></div>
        <div class="attRuleField"><label for="att-rule-checkout">Missing checkout alert after</label><input id="att-rule-checkout" type="number" min="1" max="240" value="${rules.missingCheckoutAfterMinutes}"><small>minutes after shift end</small></div>
        <div class="attRuleField"><label for="att-rule-tablet">Tablet offline alert after</label><input id="att-rule-tablet" type="number" min="1" max="60" value="${rules.tabletOfflineAfterMinutes}"><small>minutes without heartbeat</small></div>
      </div>
      <div class="attRuleChecks">
        <label class="attRuleCheck"><input id="att-rule-high" type="checkbox" ${rules.notifyHighPriority ? 'checked' : ''}> Browser notification for high-priority alerts</label>
        <label class="attRuleCheck"><input id="att-rule-medium" type="checkbox" ${rules.notifyMediumPriority ? 'checked' : ''}> Browser notification for medium-priority alerts</label>
      </div>
      <div class="attRuleFooter"><button class="attAlertBtn" id="att-save-rules">Save escalation rules</button><button class="attAlertBtn secondary" id="att-reset-rules">Reset defaults</button><span class="attRuleSaved" id="att-rule-saved"></span></div>
    </div>`;
  }

  function render(panel, alerts, rules){
    const dismissed = acked();
    const high = alerts.filter(a => a.severity === 'high').length;
    const late = alerts.filter(a => a.type === 'Late arrival').length;
    const tablets = alerts.filter(a => a.type === 'Tablet offline').length;
    const supported = 'Notification' in window;
    const notifLabel = !supported ? 'Browser alerts unsupported' : Notification.permission === 'granted' ? 'Browser alerts on' : 'Enable browser alerts';

    panel.innerHTML = `<div class="attAlertsHead"><div><h2>Alerts & notifications</h2><span>Late arrivals, missed shifts, missing check-outs and tablet connection problems.</span></div><div class="attAlertActions"><button class="attAlertBtn secondary" id="att-toggle-rules">${settingsOpen ? 'Close rules' : 'Escalation rules'}</button><button class="attAlertBtn" id="att-enable-notifications" ${!supported || Notification.permission === 'granted' ? 'disabled' : ''}>${esc(notifLabel)}</button></div></div>
      ${rulesMarkup(rules)}
      <div class="attAlertStats"><div class="attAlertStat"><strong>${alerts.length}</strong><span>Active alerts</span></div><div class="attAlertStat"><strong>${high}</strong><span>High priority</span></div><div class="attAlertStat"><strong>${late}</strong><span>Late arrivals</span></div><div class="attAlertStat"><strong>${tablets}</strong><span>Tablet alerts</span></div></div>
      <div class="attAlertList">${alerts.length ? alerts.map(a => { const done = dismissed.has(a.key); return `<div class="attAlert ${a.severity} ${done ? 'acknowledged' : ''}"><div><h3>${esc(a.title)}</h3><p>${esc(a.detail)}</p><div class="attAlertMeta">${esc(a.type)}${done ? ' · acknowledged' : ''}</div></div><div class="attAlertSide"><b class="attSeverity ${done ? 'ack' : a.severity}">${done ? 'ACK' : a.severity.toUpperCase()}</b><button class="attAck" data-key="${esc(a.key)}" data-action="${done ? 'reopen' : 'ack'}">${done ? 'Reopen' : 'Acknowledge'}</button></div></div>`; }).join('') : '<div class="attAlertEmpty">No active attendance or device alerts right now.</div>'}</div>`;

    panel.querySelector('#att-toggle-rules')?.addEventListener('click', () => { settingsOpen = !settingsOpen; refresh(true); });
    panel.querySelector('#att-enable-notifications')?.addEventListener('click', async () => { try { await Notification.requestPermission(); refresh(true); } catch {} });
    panel.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => { button.dataset.action === 'ack' ? saveAck(button.dataset.key) : reopen(button.dataset.key); refresh(true); }));

    panel.querySelector('#att-save-rules')?.addEventListener('click', () => {
      const next = {
        lateAfterMinutes: clamp(panel.querySelector('#att-rule-late')?.value, 0, 180),
        missedShiftAfterMinutes: clamp(panel.querySelector('#att-rule-missed')?.value, 1, 180),
        missingCheckoutAfterMinutes: clamp(panel.querySelector('#att-rule-checkout')?.value, 1, 240),
        tabletOfflineAfterMinutes: clamp(panel.querySelector('#att-rule-tablet')?.value, 1, 60),
        notifyHighPriority: !!panel.querySelector('#att-rule-high')?.checked,
        notifyMediumPriority: !!panel.querySelector('#att-rule-medium')?.checked
      };
      saveRules(next);
      const saved = panel.querySelector('#att-rule-saved'); if (saved) saved.textContent = 'Saved';
      setTimeout(() => refresh(true), 350);
    });
    panel.querySelector('#att-reset-rules')?.addEventListener('click', () => { saveRules({...DEFAULT_RULES}); refresh(true); });
  }

  async function refresh(force = false){
    if (loading && !force) return;
    if (!isOverview()) { document.getElementById('attendra-alerts-center')?.remove(); return; }
    const panel = ensurePanel();
    const auth = getAuth();
    if (!panel || !auth?.token || !auth?.companyId) return;
    loading = true;
    try {
      const rules = getRules();
      const [s,e,d] = await Promise.all([
        api('/v1/admin/shifts', auth.token),
        api(`/v1/companies/${encodeURIComponent(auth.companyId)}/attendance/recent`, auth.token),
        api('/v1/admin/devices', auth.token)
      ]);
      const alerts = makeAlerts(s.shifts || [], e.events || [], d.devices || [], rules);
      notifyNew(alerts, rules);
      render(panel, alerts, rules);
    } catch {
      panel.innerHTML = '<div class="attAlertsHead"><div><h2>Alerts & notifications</h2><span>Operational exceptions that need management attention.</span></div></div><div class="attAlertError">Unable to refresh alerts right now.</div>';
    } finally { loading = false; }
  }

  new MutationObserver(() => { isOverview() ? ensurePanel() : document.getElementById('attendra-alerts-center')?.remove(); }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  setInterval(refresh, REFRESH_MS);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setTimeout(refresh, 800);
})();