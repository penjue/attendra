import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Summary = { checkedInNow: number; lateToday: number; absent: number; offlineDevices: number };
type AttendanceEvent = {
  id: string;
  action: 'CHECK_IN' | 'CHECK_OUT';
  status: 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED';
  occurredAt: string;
  employeeNumber: string;
  employeeName: string;
  branchName: string;
};

const env = (import.meta as any).env as Record<string, string | undefined>;
const API_URL = env.VITE_API_URL ?? 'http://localhost:4000';
const COMPANY_ID = env.VITE_COMPANY_ID ?? '';

function App() {
  const [summary, setSummary] = useState<Summary>({ checkedInNow: 0, lateToday: 0, absent: 0, offlineDevices: 0 });
  const [events, setEvents] = useState<AttendanceEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!COMPANY_ID) return;

    const load = async () => {
      try {
        const [summaryResponse, eventsResponse] = await Promise.all([
          fetch(`${API_URL}/v1/companies/${COMPANY_ID}/attendance/summary`),
          fetch(`${API_URL}/v1/companies/${COMPANY_ID}/attendance/recent`)
        ]);
        if (!summaryResponse.ok || !eventsResponse.ok) throw new Error('API unavailable');
        const summaryData = await summaryResponse.json();
        const eventsData = await eventsResponse.json();
        setSummary(summaryData.summary);
        setEvents(eventsData.events);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    };

    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);

  return <main className="shell">
    <header>
      <div><span className="eyebrow">ATTENDRA HQ</span><h1>Workforce overview</h1></div>
      <span className={`badge ${connected ? 'online' : ''}`}>{connected ? 'Live' : 'Waiting for setup'}</span>
    </header>

    {!COMPANY_ID && <div className="setup">Set <strong>VITE_COMPANY_ID</strong> after the first company is created to activate this dashboard.</div>}

    <section className="grid">
      <article><strong>{summary.checkedInNow}</strong><span>Checked in now</span></article>
      <article><strong>{summary.lateToday}</strong><span>Late today</span></article>
      <article><strong>{summary.absent}</strong><span>Absent</span></article>
      <article><strong>{summary.offlineDevices}</strong><span>Offline devices</span></article>
    </section>

    <section className="panel">
      <div className="panelHead"><h2>Live attendance</h2><span>Refreshes every 5 seconds</span></div>
      {events.length === 0 ? <p className="empty">No attendance events yet. The first tablet check-in will appear here automatically.</p> :
        <div className="attendanceList">{events.map(event => <div className="attendanceRow" key={event.id}>
          <div><strong>{event.employeeName}</strong><span>{event.employeeNumber} · {event.branchName}</span></div>
          <div className="eventMeta"><b className={event.status.toLowerCase()}>{event.status.replace('_', ' ')}</b><span>{event.action === 'CHECK_IN' ? 'Checked in' : 'Checked out'} · {new Date(event.occurredAt).toLocaleString()}</span></div>
        </div>)}</div>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
