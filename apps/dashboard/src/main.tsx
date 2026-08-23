import React, { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Summary = { checkedInNow: number; lateToday: number; absent: number; offlineDevices: number };
type AttendanceEvent = { id: string; action: 'CHECK_IN' | 'CHECK_OUT'; status: 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED'; occurredAt: string; employeeNumber: string; employeeName: string; branchName: string };
type Employee = { id: string; employeeNumber: string; firstName: string; lastName: string; hourlyWorker: boolean; active: boolean; createdAt: string };

const env = (import.meta as any).env as Record<string, string | undefined>;
const API_URL = env.VITE_API_URL ?? 'http://localhost:4000';
const COMPANY_ID = env.VITE_COMPANY_ID ?? '';

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('attendra_admin_token') ?? '');
  const [adminEmail, setAdminEmail] = useState(() => sessionStorage.getItem('attendra_admin_email') ?? '');
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'employees'>('overview');
  const [summary, setSummary] = useState<Summary>({ checkedInNow: 0, lateToday: 0, absent: 0, offlineDevices: 0 });
  const [events, setEvents] = useState<AttendanceEvent[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [connected, setConnected] = useState(false);
  const [employeeMessage, setEmployeeMessage] = useState('');

  const makeHeaders = (extra?: HeadersInit) => {
    const headers = new Headers(extra);
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  };

  const logout = () => {
    sessionStorage.removeItem('attendra_admin_token');
    sessionStorage.removeItem('attendra_admin_email');
    setToken('');
    setAdminEmail('');
    setConnected(false);
  };

  const fetchJson = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: makeHeaders(init.headers) });
    if (response.status === 401) {
      logout();
      throw new Error('Session expired');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Request failed');
    return data;
  };

  const loadOverview = async () => {
    if (!token || !COMPANY_ID) return;
    try {
      const [summaryData, eventsData] = await Promise.all([
        fetchJson(`${API_URL}/v1/companies/${COMPANY_ID}/attendance/summary`),
        fetchJson(`${API_URL}/v1/companies/${COMPANY_ID}/attendance/recent`)
      ]);
      setSummary(summaryData.summary);
      setEvents(eventsData.events);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  };

  const loadEmployees = async () => {
    if (!token) return;
    try {
      const data = await fetchJson(`${API_URL}/v1/admin/employees`);
      setEmployees(data.employees);
    } catch (error: any) {
      setEmployeeMessage(error.message);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadOverview();
    loadEmployees();
    const timer = window.setInterval(loadOverview, 5000);
    return () => window.clearInterval(timer);
  }, [token]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${API_URL}/v1/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Login failed');
      sessionStorage.setItem('attendra_admin_token', data.token);
      sessionStorage.setItem('attendra_admin_email', data.email);
      setToken(data.token);
      setAdminEmail(data.email);
    } catch (error: any) {
      setLoginError(error.message === 'ADMIN_NOT_CONFIGURED' ? 'Admin login has not been configured on the server yet.' : 'Email or password is incorrect.');
    }
  };

  const addEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setEmployeeMessage('');
    const form = new FormData(event.currentTarget);
    try {
      await fetchJson(`${API_URL}/v1/admin/employees`, {
        method: 'POST',
        body: JSON.stringify({
          employeeNumber: form.get('employeeNumber'),
          firstName: form.get('firstName'),
          lastName: form.get('lastName'),
          pin: form.get('pin'),
          hourlyWorker: form.get('hourlyWorker') === 'on'
        })
      });
      event.currentTarget.reset();
      setEmployeeMessage('Employee added successfully.');
      await loadEmployees();
    } catch (error: any) {
      setEmployeeMessage(error.message === 'EMPLOYEE_NUMBER_EXISTS' ? 'That employee number already exists.' : error.message);
    }
  };

  const updateEmployee = async (employee: Employee, changes: Record<string, unknown>) => {
    setEmployeeMessage('');
    try {
      await fetchJson(`${API_URL}/v1/admin/employees/${employee.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      setEmployeeMessage('Employee updated successfully.');
      await loadEmployees();
    } catch (error: any) {
      setEmployeeMessage(error.message);
    }
  };

  const resetPin = async (employee: Employee) => {
    const pin = window.prompt(`Enter a new 4–12 digit PIN for ${employee.firstName} ${employee.lastName}`);
    if (pin === null) return;
    if (!/^\d{4,12}$/.test(pin)) {
      setEmployeeMessage('PIN must contain 4–12 digits.');
      return;
    }
    await updateEmployee(employee, { pin });
  };

  if (!token) return <main className="loginShell">
    <section className="loginCard">
      <span className="eyebrow">ATTENDRA HQ</span>
      <h1>Manager sign in</h1>
      <p>Secure access to workforce attendance and employee management.</p>
      <form onSubmit={login} className="loginForm">
        <label>Email<input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required /></label>
        {loginError && <div className="errorBox">{loginError}</div>}
        <button type="submit" className="primary">Sign in</button>
      </form>
    </section>
  </main>;

  return <main className="shell">
    <header>
      <div><span className="eyebrow">ATTENDRA HQ</span><h1>{activeTab === 'overview' ? 'Workforce overview' : 'Employees'}</h1></div>
      <div className="headerActions"><span className={`badge ${connected ? 'online' : ''}`}>{connected ? 'Live' : 'Connecting'}</span><button className="linkButton" onClick={logout}>Sign out</button></div>
    </header>

    <nav className="tabs">
      <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
      <button className={activeTab === 'employees' ? 'active' : ''} onClick={() => { setActiveTab('employees'); loadEmployees(); }}>Employees</button>
      <span className="adminIdentity">{adminEmail}</span>
    </nav>

    {activeTab === 'overview' ? <>
      <section className="grid">
        <article><strong>{summary.checkedInNow}</strong><span>Checked in now</span></article>
        <article><strong>{summary.lateToday}</strong><span>Late today</span></article>
        <article><strong>{summary.absent}</strong><span>Absent</span></article>
        <article><strong>{summary.offlineDevices}</strong><span>Offline devices</span></article>
      </section>

      <section className="panel">
        <div className="panelHead"><h2>Live attendance</h2><span>Refreshes every 5 seconds</span></div>
        {events.length === 0 ? <p className="empty">No attendance events yet.</p> : <div className="attendanceList">{events.map(event => <div className="attendanceRow" key={event.id}>
          <div><strong>{event.employeeName}</strong><span>{event.employeeNumber} · {event.branchName}</span></div>
          <div className="eventMeta"><b className={event.status.toLowerCase()}>{event.status.replace('_', ' ')}</b><span>{event.action === 'CHECK_IN' ? 'Checked in' : 'Checked out'} · {new Date(event.occurredAt).toLocaleString()}</span></div>
        </div>)}</div>}
      </section>
    </> : <>
      <section className="panel employeeFormPanel">
        <div className="panelHead"><div><h2>Add employee</h2><span>Create an employee number and private PIN.</span></div></div>
        <form onSubmit={addEmployee} className="employeeForm">
          <label>Employee number<input name="employeeNumber" placeholder="e.g. 1043" required /></label>
          <label>First name<input name="firstName" required /></label>
          <label>Last name<input name="lastName" required /></label>
          <label>PIN<input name="pin" inputMode="numeric" type="password" pattern="[0-9]{4,12}" placeholder="4–12 digits" required /></label>
          <label className="checkLabel"><input name="hourlyWorker" type="checkbox" /> Hourly worker</label>
          <button className="primary" type="submit">Add employee</button>
        </form>
        {employeeMessage && <div className="infoBox">{employeeMessage}</div>}
      </section>

      <section className="panel">
        <div className="panelHead"><h2>Employee directory</h2><span>{employees.length} employees</span></div>
        <div className="employeeList">{employees.map(employee => <div className="employeeRow" key={employee.id}>
          <div><strong>{employee.firstName} {employee.lastName}</strong><span>#{employee.employeeNumber} · {employee.hourlyWorker ? 'Hourly' : 'Salaried'} · {employee.active ? 'Active' : 'Inactive'}</span></div>
          <div className="rowActions"><button onClick={() => resetPin(employee)}>Reset PIN</button><button onClick={() => updateEmployee(employee, { active: !employee.active })}>{employee.active ? 'Deactivate' : 'Activate'}</button></div>
        </div>)}</div>
      </section>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
