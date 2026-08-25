import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const env = (import.meta as any).env as Record<string, string | undefined>;
const API_URL = env.VITE_API_URL ?? 'http://localhost:4000';
const COMPANY_ID = env.VITE_COMPANY_ID ?? '';
const BRANCH_ID = env.VITE_BRANCH_ID ?? '';
const DEVICE_ID = env.VITE_DEVICE_ID ?? '';
const BRANCH_NAME = env.VITE_BRANCH_NAME ?? 'Attendra Branch';

type AttendanceStatus = 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED';

const statusText = (status: AttendanceStatus | undefined) => {
  if (status === 'ON_TIME') return 'You are on time.';
  if (status === 'LATE') return 'Your check-in has been recorded as late.';
  if (status === 'EARLY') return 'You have checked in early.';
  if (status === 'UNSCHEDULED') return 'No matching scheduled shift was found.';
  return '';
};

function App() {
  const [employee, setEmployee] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const configured = Boolean(COMPANY_ID && BRANCH_ID && DEVICE_ID);

  const submit = async (action: 'CHECK_IN' | 'CHECK_OUT') => {
    if (!configured || !employee || pin.length < 4 || busy) return;
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`${API_URL}/v1/attendance/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: COMPANY_ID,
          branchId: BRANCH_ID,
          deviceId: DEVICE_ID,
          employeeNumber: employee.trim(),
          pin,
          action,
          occurredAt: new Date().toISOString()
        })
      });

      const data = await response.json();
      if (!response.ok) {
        const text = data.error === 'INVALID_EMPLOYEE_OR_PIN'
          ? 'Employee number or PIN is incorrect.'
          : data.error === 'DEVICE_NOT_AUTHORISED'
            ? 'This tablet is not authorised for this branch.'
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
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Unable to record attendance.' });
    } finally {
      setBusy(false);
    }
  };

  return <main className="kiosk">
    <div className="brand">Attendra</div>
    <p className="branch">{BRANCH_NAME} · Registered tablet</p>
    <section className="card">
      <h1>Welcome</h1><p>Enter your employee number and PIN.</p>
      {!configured && <div className="notice error">This tablet has not been registered yet.</div>}
      {message && <div className={`notice ${message.type}`}>{message.text}</div>}
      <label>Employee number<input autoComplete="off" value={employee} onChange={e=>setEmployee(e.target.value)} placeholder="e.g. 1042" /></label>
      <label>PIN<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="••••" /></label>
      <div className="actions">
        <button onClick={()=>submit('CHECK_IN')} disabled={!configured||!employee||pin.length<4||busy}>{busy ? 'Please wait…' : 'Check in'}</button>
        <button onClick={()=>submit('CHECK_OUT')} className="secondary" disabled={!configured||!employee||pin.length<4||busy}>Check out</button>
      </div>
      <small>Your PIN is verified securely and is never stored in the attendance record.</small>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
