import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const env = (import.meta as any).env as Record<string, string | undefined>;
const API_URL = env.VITE_API_URL ?? 'http://localhost:4000';
const STORAGE_KEY = 'attendra_tablet_config_v1';

type TabletConfig = {
  companyId: string;
  branchId: string;
  deviceId: string;
  branchName: string;
  deviceName?: string;
  deviceKey?: string;
};

type AttendanceStatus = 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED';

const statusText = (status: AttendanceStatus | undefined) => {
  if (status === 'ON_TIME') return 'You are on time.';
  if (status === 'LATE') return 'Your check-in has been recorded as late.';
  if (status === 'EARLY') return 'You have checked in early.';
  return '';
};

const readStoredConfig = (): TabletConfig | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as TabletConfig;
    return value.companyId && value.branchId && value.deviceId ? value : null;
  } catch {
    return null;
  }
};

const legacyConfig = (): TabletConfig | null => {
  const companyId = env.VITE_COMPANY_ID ?? '';
  const branchId = env.VITE_BRANCH_ID ?? '';
  const deviceId = env.VITE_DEVICE_ID ?? '';
  if (!companyId || !branchId || !deviceId) return null;
  return {
    companyId,
    branchId,
    deviceId,
    branchName: env.VITE_BRANCH_NAME ?? 'Attendra Branch'
  };
};

const configFromUrl = (): TabletConfig | null => {
  const p = new URLSearchParams(window.location.search);
  const companyId = p.get('companyId')?.trim() ?? '';
  const branchId = p.get('branchId')?.trim() ?? '';
  const deviceId = p.get('deviceId')?.trim() ?? '';
  if (!companyId || !branchId || !deviceId) return null;
  return {
    companyId,
    branchId,
    deviceId,
    branchName: p.get('branchName')?.trim() || 'Attendra Branch',
    deviceName: p.get('deviceName')?.trim() || undefined,
    deviceKey: p.get('deviceKey')?.trim() || undefined
  };
};

function App() {
  const [config, setConfig] = useState<TabletConfig | null>(() => configFromUrl() ?? readStoredConfig() ?? legacyConfig());
  const [employee, setEmployee] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [heartbeatStatus, setHeartbeatStatus] = useState<{ ok: boolean; text: string; at?: string }>({ ok: false, text: 'Waiting for heartbeat…' });
  const [showTabletSettings, setShowTabletSettings] = useState(false);
  const [pendingSync, setPendingSync] = useState(0);

  useEffect(() => {
    const incoming = configFromUrl();
    if (!incoming) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(incoming));
    window.history.replaceState({}, document.title, window.location.pathname);
  }, []);

  const configured = Boolean(config?.companyId && config?.branchId && config?.deviceId);

  useEffect(() => {
    if (!configured || !config) return;
    const heartbeat = async () => {
      try {
        const response = await fetch(`${API_URL}/v1/devices/heartbeat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            companyId: config.companyId,
            branchId: config.branchId,
            deviceId: config.deviceId,
            deviceKey: config.deviceKey
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setHeartbeatStatus({ ok: false, text: `Heartbeat failed: ${data.error ?? `HTTP ${response.status}`}`, at: new Date().toISOString() });
          return;
        }
        setHeartbeatStatus({ ok: true, text: 'Connected to Attendra HQ', at: data.device?.lastSeenAt ?? new Date().toISOString() });
      } catch (error) {
        setHeartbeatStatus({ ok: false, text: `Heartbeat network error: ${error instanceof Error ? error.message : 'Unable to reach API'}`, at: new Date().toISOString() });
      }
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') heartbeat(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', heartbeat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', heartbeat);
    };
  }, [configured, config]);

  const QUEUE_KEY = 'attendra-offline-attendance-v1';
  const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as any[]; } catch { return []; } };
  const writeQueue = (items: any[]) => { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); setPendingSync(items.length); };
  const syncQueue = async () => {
    if (!config || !navigator.onLine) return;
    const queued = readQueue(); if (!queued.length) { setPendingSync(0); return; }
    const remaining:any[] = [];
    for (const item of queued) {
      try {
        const response = await fetch(`${API_URL}/v1/attendance/events`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(item) });
        if (!response.ok) remaining.push(item);
      } catch { remaining.push(item); }
    }
    writeQueue(remaining);
  };

  useEffect(() => {
    setPendingSync(readQueue().length);
    const onOnline = () => { void syncQueue(); };
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => { void syncQueue(); }, 30000);
    void syncQueue();
    return () => { window.removeEventListener('online', onOnline); window.clearInterval(timer); };
  }, [config?.deviceId, config?.deviceKey]);

  const submit = async (action: 'CHECK_IN' | 'CHECK_OUT') => {
    if (!config || !configured || !employee || pin.length < 4 || busy) return;
    setBusy(true);
    setMessage(null);

    try {
      const occurredAt = new Date().toISOString();
      const clientEventId = crypto.randomUUID();
      const eligibility = await fetch(`${API_URL}/v1/attendance/eligibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: config.companyId,
          branchId: config.branchId,
          employeeNumber: employee.trim(),
          pin,
          action,
          occurredAt,
          clientEventId,
          deviceKey: config.deviceKey
        })
      });
      const eligibilityData = await eligibility.json();
      if (!eligibility.ok) {
        const text = eligibilityData.error === 'INVALID_EMPLOYEE_OR_PIN'
          ? 'Employee number or PIN is incorrect.'
          : eligibilityData.error === 'NO_SCHEDULED_SHIFT'
            ? 'You do not have a scheduled shift at this branch right now. Please contact your manager.'
            : 'Unable to verify your scheduled shift. Please try again.';
        throw new Error(text);
      }

      const response = await fetch(`${API_URL}/v1/attendance/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: config.companyId,
          branchId: config.branchId,
          deviceId: config.deviceId,
          deviceKey: config.deviceKey,
          employeeNumber: employee.trim(),
          pin,
          action,
          occurredAt
        })
      });

      const data = await response.json();
      if (!response.ok) {
        const text = data.error === 'INVALID_EMPLOYEE_OR_PIN'
          ? 'Employee number or PIN is incorrect.'
          : data.error === 'DEVICE_NOT_AUTHORISED'
            ? 'This tablet is not authorised for this branch.'
            : data.error === 'NO_SCHEDULED_SHIFT' || data.error === 'ATTENDANCE_WRITE_FAILED'
              ? 'You do not have a scheduled shift at this branch right now. Please contact your manager.'
              : 'Unable to record attendance. Please try again.';
        throw new Error(text);
      }

      const attendanceStatus = data.event?.status as AttendanceStatus | undefined;
      const detail = action === 'CHECK_IN' ? statusText(attendanceStatus) : '';
      setMessage({
        type: 'success',
        text: `${data.employee.name}, you are ${action === 'CHECK_IN' ? 'checked in' : 'checked out'} successfully.${detail ? ` ${detail}` : ''}`
      });
      setEmployee('');
      setPin('');
    } catch (error) {
      const networkFailure = !navigator.onLine || (error instanceof TypeError);
      if (networkFailure && config) {
        const queued = readQueue();
        queued.push({ companyId:config.companyId, branchId:config.branchId, deviceId:config.deviceId, deviceKey:config.deviceKey, employeeNumber:employee.trim(), pin, action, occurredAt:new Date().toISOString(), clientEventId:crypto.randomUUID() });
        writeQueue(queued);
        setMessage({ type:'success', text:'Internet unavailable. Attendance saved securely on this tablet and will sync automatically when the connection returns.' });
      } else {
        setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Unable to record attendance.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const resetTablet = () => {
    if (!window.confirm('Remove this tablet registration from this browser? The tablet will need to be activated again.')) return;
    localStorage.removeItem(STORAGE_KEY);
    setConfig(null);
    setMessage(null);
  };

  if (!configured || !config) {
    return <main className="kiosk">
      <div className="brand">Attendra</div>
      <p className="branch">Tablet activation</p>
      <section className="card">
        <h1>Set up this tablet</h1>
        <p>This device has not been assigned to a company branch yet.</p>
        <div className="notice error">Ask your company administrator to open Devices in Attendra HQ and generate a tablet activation link.</div>
        <p>Open that activation link on this tablet. Attendra will then remember the company, branch and tablet automatically.</p>
      </section>
    </main>;
  }

  return <main className="kiosk">
    <div className="brand">Attendra</div>
    <p className="branch">{config.branchName} · Registered tablet</p>
    <section className="card">
      <h1>Welcome</h1><p>Enter your employee number and PIN.</p>
      {message && <div className={`notice ${message.type}`}>{message.text}</div>}
      <label>Employee number<input autoComplete="off" value={employee} onChange={e=>setEmployee(e.target.value)} placeholder="e.g. 1042" /></label>
      <label>PIN<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="••••" /></label>
      <div className="actions">
        <button onClick={()=>submit('CHECK_IN')} disabled={!employee||pin.length<4||busy}>{busy ? 'Please wait…' : 'Check in'}</button>
        <button onClick={()=>submit('CHECK_OUT')} className="secondary" disabled={!employee||pin.length<4||busy}>Check out</button>
      </div>
      <small>Your PIN is verified securely and is never stored in the attendance record.</small>
      <button className="secondary" style={{marginTop: 16, width: '100%'}} onClick={()=>setShowTabletSettings(value=>!value)}>Tablet settings</button>
      {showTabletSettings && <div className={`notice ${heartbeatStatus.ok ? 'success' : 'error'}`} style={{marginTop: 12}}>
        <strong>Connection status</strong>
        <p><strong>Pending attendance sync: {pendingSync}</strong></p>
        <p>{heartbeatStatus.text}</p>
        {heartbeatStatus.at && <small>Last heartbeat attempt: {new Date(heartbeatStatus.at).toLocaleString()}</small>}
        <p><small>Device: {config.deviceName ?? config.deviceId}</small></p>
        <button className="secondary" style={{width: '100%'}} onClick={resetTablet}>Remove tablet registration</button>
      </div>}
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
