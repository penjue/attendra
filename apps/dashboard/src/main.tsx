import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Summary = { checkedInNow: number; lateToday: number; absent: number; offlineDevices: number };
type AttendanceEvent = { id: string; action: 'CHECK_IN' | 'CHECK_OUT'; status: 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED'; occurredAt: string; employeeNumber: string; employeeName: string; branchName: string };
type Employee = { id: string; employeeNumber: string; firstName: string; lastName: string; hourlyWorker: boolean; active: boolean; createdAt: string };
type Branch = { id: string; name: string; timezone: string; address: string | null; active: boolean; createdAt: string; deviceCount?: number };
type Device = { id: string; name: string; branchId: string; branchName: string; lastSeenAt: string | null; active: boolean; online: boolean; createdAt: string };
type Shift = { id: string; employeeId: string; employeeName: string; employeeNumber: string; branchId: string; branchName: string; startsAt: string; endsAt: string; breakMinutes: number; createdAt: string };
type Tab = 'overview' | 'employees' | 'branches' | 'devices' | 'shifts';

const env = (import.meta as any).env as Record<string, string | undefined>;
const API_URL = env.VITE_API_URL ?? 'http://localhost:4000';
const COMPANY_ID = env.VITE_COMPANY_ID ?? '';

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('attendra_admin_token') ?? '');
  const [adminEmail, setAdminEmail] = useState(() => sessionStorage.getItem('attendra_admin_email') ?? '');
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [summary, setSummary] = useState<Summary>({ checkedInNow: 0, lateToday: 0, absent: 0, offlineDevices: 0 });
  const [events, setEvents] = useState<AttendanceEvent[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [connected, setConnected] = useState(false);
  const [employeeMessage, setEmployeeMessage] = useState('');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [branchMessage, setBranchMessage] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceFilter, setDeviceFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [shiftMessage, setShiftMessage] = useState('');
  const [shiftSearch, setShiftSearch] = useState('');
  const [shiftFilter, setShiftFilter] = useState<'upcoming' | 'all' | 'past'>('upcoming');

  const makeHeaders = (extra?: HeadersInit) => {
    const headers = new Headers(extra);
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  };

  const logout = () => {
    sessionStorage.removeItem('attendra_admin_token');
    sessionStorage.removeItem('attendra_admin_email');
    setToken(''); setAdminEmail(''); setConnected(false);
  };

  const fetchJson = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: makeHeaders(init.headers) });
    if (response.status === 401) { logout(); throw new Error('Session expired'); }
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
      setSummary(summaryData.summary); setEvents(eventsData.events); setConnected(true);
    } catch { setConnected(false); }
  };

  const loadEmployees = async () => {
    if (!token) return;
    try { const data = await fetchJson(`${API_URL}/v1/admin/employees`); setEmployees(data.employees); }
    catch (error: any) { setEmployeeMessage(error.message); }
  };

  const loadBranches = async () => {
    if (!token) return;
    try { const data = await fetchJson(`${API_URL}/v1/admin/branches`); setBranches(data.branches); }
    catch (error: any) { setBranchMessage(error.message); }
  };

  const loadDevices = async () => {
    if (!token) return;
    try { const data = await fetchJson(`${API_URL}/v1/admin/devices`); setDevices(data.devices); }
    catch (error: any) { setDeviceMessage(error.message); }
  };

  const loadShifts = async () => {
    if (!token) return;
    try { const data = await fetchJson(`${API_URL}/v1/admin/shifts`); setShifts(data.shifts); }
    catch { setShiftMessage('Unable to refresh the shift schedule. Please try again.'); }
  };

  useEffect(() => {
    if (!token) return;
    loadOverview(); loadEmployees(); loadBranches(); loadDevices(); loadShifts();
    const timer = window.setInterval(loadOverview, 5000);
    return () => window.clearInterval(timer);
  }, [token]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoginError(''); const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${API_URL}/v1/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Login failed');
      sessionStorage.setItem('attendra_admin_token', data.token); sessionStorage.setItem('attendra_admin_email', data.email); setToken(data.token); setAdminEmail(data.email);
    } catch (error: any) { setLoginError(error.message === 'ADMIN_NOT_CONFIGURED' ? 'Admin login has not been configured on the server yet.' : 'Email or password is incorrect.'); }
  };

  const addEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setEmployeeMessage(''); const form = new FormData(event.currentTarget);
    try {
      await fetchJson(`${API_URL}/v1/admin/employees`, { method: 'POST', body: JSON.stringify({ employeeNumber: form.get('employeeNumber'), firstName: form.get('firstName'), lastName: form.get('lastName'), pin: form.get('pin'), hourlyWorker: form.get('hourlyWorker') === 'on' }) });
      event.currentTarget.reset(); setEmployeeMessage('Employee added successfully.'); await loadEmployees();
    } catch (error: any) { setEmployeeMessage(error.message === 'EMPLOYEE_NUMBER_EXISTS' ? 'That employee number already exists.' : error.message); }
  };

  const updateEmployee = async (employee: Employee, changes: Record<string, unknown>, successMessage = 'Employee updated successfully.') => {
    setEmployeeMessage('');
    try { await fetchJson(`${API_URL}/v1/admin/employees/${employee.id}`, { method: 'PATCH', body: JSON.stringify(changes) }); setEmployeeMessage(successMessage); await loadEmployees(); }
    catch (error: any) { setEmployeeMessage(error.message); }
  };

  const resetPin = async (employee: Employee) => {
    const pin = window.prompt(`Enter a new 4–12 digit PIN for ${employee.firstName} ${employee.lastName}`); if (pin === null) return;
    if (!/^\d{4,12}$/.test(pin)) return setEmployeeMessage('PIN must contain 4–12 digits.');
    await updateEmployee(employee, { pin }, 'PIN reset successfully.');
  };

  const editEmployee = async (employee: Employee) => {
    const firstName = window.prompt('First name', employee.firstName); if (firstName === null) return;
    const lastName = window.prompt('Last name', employee.lastName); if (lastName === null) return;
    if (!firstName.trim() || !lastName.trim()) return setEmployeeMessage('First name and last name are required.');
    await updateEmployee(employee, { firstName: firstName.trim(), lastName: lastName.trim() }, 'Employee details updated.');
  };

  const addBranch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBranchMessage(''); const form = new FormData(event.currentTarget);
    try { await fetchJson(`${API_URL}/v1/admin/branches`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), timezone: form.get('timezone'), address: form.get('address') }) }); event.currentTarget.reset(); setBranchMessage('Branch added successfully.'); await loadBranches(); }
    catch (error: any) { setBranchMessage(error.message); }
  };

  const updateBranch = async (branch: Branch, changes: Record<string, unknown>, successMessage = 'Branch updated successfully.') => {
    setBranchMessage('');
    try { await fetchJson(`${API_URL}/v1/admin/branches/${branch.id}`, { method: 'PATCH', body: JSON.stringify(changes) }); setBranchMessage(successMessage); await loadBranches(); }
    catch (error: any) { setBranchMessage(error.message); }
  };

  const editBranch = async (branch: Branch) => {
    const name = window.prompt('Branch name', branch.name); if (name === null) return;
    const timezone = window.prompt('Timezone', branch.timezone); if (timezone === null) return;
    const address = window.prompt('Address', branch.address ?? ''); if (address === null) return;
    if (!name.trim() || !timezone.trim()) return setBranchMessage('Branch name and timezone are required.');
    await updateBranch(branch, { name: name.trim(), timezone: timezone.trim(), address: address.trim() }, 'Branch details updated.');
  };

  const addDevice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setDeviceMessage(''); const form = new FormData(event.currentTarget);
    try { await fetchJson(`${API_URL}/v1/admin/devices`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), branchId: form.get('branchId') }) }); event.currentTarget.reset(); setDeviceMessage('Tablet registered successfully.'); await Promise.all([loadDevices(), loadBranches(), loadOverview()]); }
    catch (error: any) { setDeviceMessage(error.message); }
  };

  const updateDevice = async (device: Device, changes: Record<string, unknown>, successMessage = 'Tablet updated successfully.') => {
    setDeviceMessage('');
    try { await fetchJson(`${API_URL}/v1/admin/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify(changes) }); setDeviceMessage(successMessage); await Promise.all([loadDevices(), loadBranches(), loadOverview()]); }
    catch (error: any) { setDeviceMessage(error.message); }
  };

  const editDevice = async (device: Device) => {
    const name = window.prompt('Tablet name', device.name); if (name === null) return;
    if (!name.trim()) return setDeviceMessage('Tablet name is required.');
    await updateDevice(device, { name: name.trim() }, 'Tablet name updated.');
  };

  const shiftErrorMessage = (message: string) => {
    if (message === 'SHIFT_END_MUST_BE_AFTER_START') return 'Shift end time must be after the start time.';
    if (message === 'SHIFT_OVERLAP') return 'This employee already has a shift that overlaps these times.';
    if (message === 'INVALID_SHIFT' || message === 'Bad Request') return 'Please complete all shift details correctly and try again.';
    if (message === 'EMPLOYEE_NOT_FOUND') return 'The selected employee is not available.';
    if (message === 'BRANCH_NOT_FOUND') return 'The selected branch is not available.';
    return message || 'Unable to schedule this shift.';
  };

  const addShift = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setShiftMessage('');
    const form = new FormData(formElement);
    try {
      const startsAt = new Date(String(form.get('startsAt'))).toISOString();
      const endsAt = new Date(String(form.get('endsAt'))).toISOString();
      await fetchJson(`${API_URL}/v1/admin/shifts`, { method: 'POST', body: JSON.stringify({ employeeId: form.get('employeeId'), branchId: form.get('branchId'), startsAt, endsAt, breakMinutes: Number(form.get('breakMinutes') || 0) }) });
      formElement.reset(); setShiftMessage('Shift scheduled successfully.'); await loadShifts();
    } catch (error: any) { setShiftMessage(shiftErrorMessage(error.message)); }
  };

  const deleteShift = async (shift: Shift) => {
    if (!window.confirm(`Delete ${shift.employeeName}'s shift at ${shift.branchName}?`)) return;
    setShiftMessage('');
    try { await fetchJson(`${API_URL}/v1/admin/shifts/${shift.id}`, { method: 'DELETE' }); setShiftMessage('Shift deleted.'); await loadShifts(); }
    catch (error: any) { setShiftMessage(error.message === 'SHIFT_HAS_ATTENDANCE' ? 'This shift already has attendance records and cannot be deleted.' : error.message); }
  };

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    return employees.filter(employee => (employeeFilter === 'all' || (employeeFilter === 'active' ? employee.active : !employee.active)) && (!q || `${employee.firstName} ${employee.lastName} ${employee.employeeNumber}`.toLowerCase().includes(q)));
  }, [employees, employeeSearch, employeeFilter]);

  const filteredBranches = useMemo(() => {
    const q = branchSearch.trim().toLowerCase();
    return branches.filter(branch => (branchFilter === 'all' || (branchFilter === 'active' ? branch.active : !branch.active)) && (!q || `${branch.name} ${branch.address ?? ''} ${branch.timezone}`.toLowerCase().includes(q)));
  }, [branches, branchSearch, branchFilter]);

  const filteredDevices = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    return devices.filter(device => (deviceFilter === 'all' || (deviceFilter === 'active' ? device.active : !device.active)) && (!q || `${device.name} ${device.branchName}`.toLowerCase().includes(q)));
  }, [devices, deviceSearch, deviceFilter]);

  const filteredShifts = useMemo(() => {
    const q = shiftSearch.trim().toLowerCase(); const now = Date.now();
    return shifts.filter(shift => {
      const end = new Date(shift.endsAt).getTime();
      const period = shiftFilter === 'all' || (shiftFilter === 'upcoming' ? end >= now : end < now);
      return period && (!q || `${shift.employeeName} ${shift.employeeNumber} ${shift.branchName}`.toLowerCase().includes(q));
    });
  }, [shifts, shiftSearch, shiftFilter]);

  if (!token) return <main className="loginShell"><section className="loginCard">
    <span className="eyebrow">ATTENDRA HQ</span><h1>Manager sign in</h1><p>Secure access to workforce attendance and employee management.</p>
    <form onSubmit={login} className="loginForm"><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required /></label>{loginError && <div className="errorBox">{loginError}</div>}<button type="submit" className="primary">Sign in</button></form>
  </section></main>;

  const title = activeTab === 'overview' ? 'Workforce overview' : activeTab === 'employees' ? 'Employees' : activeTab === 'branches' ? 'Branches' : activeTab === 'devices' ? 'Devices' : 'Shifts';

  return <main className="shell">
    <header><div><span className="eyebrow">ATTENDRA HQ</span><h1>{title}</h1></div><div className="headerActions"><span className={`badge ${connected ? 'online' : ''}`}>{connected ? 'Live' : 'Connecting'}</span><button className="linkButton" onClick={logout}>Sign out</button></div></header>
    <nav className="tabs">
      <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
      <button className={activeTab === 'employees' ? 'active' : ''} onClick={() => { setActiveTab('employees'); loadEmployees(); }}>Employees</button>
      <button className={activeTab === 'branches' ? 'active' : ''} onClick={() => { setActiveTab('branches'); loadBranches(); }}>Branches</button>
      <button className={activeTab === 'devices' ? 'active' : ''} onClick={() => { setActiveTab('devices'); loadDevices(); loadBranches(); }}>Devices</button>
      <button className={activeTab === 'shifts' ? 'active' : ''} onClick={() => { setActiveTab('shifts'); loadShifts(); loadEmployees(); loadBranches(); }}>Shifts</button>
      <span className="adminIdentity">{adminEmail}</span>
    </nav>

    {activeTab === 'overview' && <>
      <section className="grid"><article><strong>{summary.checkedInNow}</strong><span>Checked in now</span></article><article><strong>{summary.lateToday}</strong><span>Late today</span></article><article><strong>{summary.absent}</strong><span>Absent</span></article><article><strong>{summary.offlineDevices}</strong><span>Offline devices</span></article></section>
      <section className="panel"><div className="panelHead"><h2>Live attendance</h2><span>Refreshes every 5 seconds</span></div>{events.length === 0 ? <p className="empty">No attendance events yet.</p> : <div className="attendanceList">{events.map(event => <div className="attendanceRow" key={event.id}><div><strong>{event.employeeName}</strong><span>{event.employeeNumber} · {event.branchName}</span></div><div className="eventMeta"><b className={event.status.toLowerCase()}>{event.status.replace('_', ' ')}</b><span>{event.action === 'CHECK_IN' ? 'Checked in' : 'Checked out'} · {new Date(event.occurredAt).toLocaleString()}</span></div></div>)}</div>}</section>
    </>}

    {activeTab === 'employees' && <>
      <section className="panel employeeFormPanel"><div className="panelHead"><div><h2>Add employee</h2><span>Create an employee number and private PIN.</span></div></div><form onSubmit={addEmployee} className="employeeForm"><label>Employee number<input name="employeeNumber" placeholder="e.g. 1043" required /></label><label>First name<input name="firstName" required /></label><label>Last name<input name="lastName" required /></label><label>PIN<input name="pin" inputMode="numeric" type="password" pattern="[0-9]{4,12}" placeholder="4–12 digits" required /></label><label className="checkLabel"><input name="hourlyWorker" type="checkbox" /> Hourly worker</label><button className="primary" type="submit">Add employee</button></form>{employeeMessage && <div className="infoBox">{employeeMessage}</div>}</section>
      <section className="panel"><div className="panelHead"><div><h2>Employee directory</h2><span>{employees.filter(e => e.active).length} active · {employees.length} total</span></div></div><div className="directoryTools"><input value={employeeSearch} onChange={e => setEmployeeSearch(e.target.value)} placeholder="Search name or employee number" /><select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value as any)}><option value="all">All employees</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select></div><div className="employeeList">{filteredEmployees.length === 0 ? <p className="empty">No employees match this search.</p> : filteredEmployees.map(employee => <div className="employeeRow" key={employee.id}><div><strong>{employee.firstName} {employee.lastName}</strong><span>#{employee.employeeNumber} · {employee.hourlyWorker ? 'Hourly' : 'Salaried'} · {employee.active ? 'Active' : 'Inactive'}</span></div><div className="rowActions"><button onClick={() => editEmployee(employee)}>Edit</button><button onClick={() => updateEmployee(employee, { hourlyWorker: !employee.hourlyWorker }, employee.hourlyWorker ? 'Changed to salaried worker.' : 'Changed to hourly worker.')}>{employee.hourlyWorker ? 'Make salaried' : 'Make hourly'}</button><button onClick={() => resetPin(employee)}>Reset PIN</button><button className={employee.active ? 'dangerAction' : ''} onClick={() => updateEmployee(employee, { active: !employee.active }, employee.active ? 'Employee deactivated.' : 'Employee activated.')}>{employee.active ? 'Deactivate' : 'Activate'}</button></div></div>)}</div></section>
    </>}

    {activeTab === 'branches' && <>
      <section className="panel branchFormPanel"><div className="panelHead"><div><h2>Add branch</h2><span>Create a workplace location and assign its timezone.</span></div></div><form onSubmit={addBranch} className="branchForm"><label>Branch name<input name="name" placeholder="e.g. Manchester City Centre" required /></label><label>Timezone<input name="timezone" placeholder="e.g. Europe/London" defaultValue="Europe/London" required /></label><label className="wideField">Address<input name="address" placeholder="Street, city, postcode" /></label><button className="primary" type="submit">Add branch</button></form>{branchMessage && <div className="infoBox">{branchMessage}</div>}</section>
      <section className="panel"><div className="panelHead"><div><h2>Branch directory</h2><span>{branches.filter(b => b.active).length} active · {branches.length} total</span></div></div><div className="directoryTools"><input value={branchSearch} onChange={e => setBranchSearch(e.target.value)} placeholder="Search branch, address or timezone" /><select value={branchFilter} onChange={e => setBranchFilter(e.target.value as any)}><option value="all">All branches</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select></div><div className="branchList">{filteredBranches.length === 0 ? <p className="empty">No branches match this search.</p> : filteredBranches.map(branch => <div className="branchRow" key={branch.id}><div className="branchSummary"><strong>{branch.name}</strong><span>{branch.address || 'No address added'}</span><small>{branch.timezone} · {branch.deviceCount ?? 0} active device{(branch.deviceCount ?? 0) === 1 ? '' : 's'} · {branch.active ? 'Active' : 'Inactive'}</small></div><div className="rowActions"><button onClick={() => editBranch(branch)}>Edit</button><button className={branch.active ? 'dangerAction' : ''} onClick={() => updateBranch(branch, { active: !branch.active }, branch.active ? 'Branch deactivated.' : 'Branch activated.')}>{branch.active ? 'Deactivate' : 'Activate'}</button></div></div>)}</div></section>
    </>}

    {activeTab === 'devices' && <>
      <section className="panel branchFormPanel"><div className="panelHead"><div><h2>Register tablet</h2><span>Authorise an attendance tablet and assign it to a branch.</span></div></div><form onSubmit={addDevice} className="branchForm"><label>Tablet name<input name="name" placeholder="e.g. Reception Tablet" required /></label><label>Branch<select name="branchId" required defaultValue=""><option value="" disabled>Select branch</option>{branches.filter(b => b.active).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><button className="primary" type="submit" disabled={branches.filter(b => b.active).length === 0}>Register tablet</button></form>{deviceMessage && <div className="infoBox">{deviceMessage}</div>}</section>
      <section className="panel"><div className="panelHead"><div><h2>Device directory</h2><span>{devices.filter(d => d.active).length} active · {devices.filter(d => d.online).length} online · {devices.length} total</span></div></div><div className="directoryTools"><input value={deviceSearch} onChange={e => setDeviceSearch(e.target.value)} placeholder="Search tablet or branch" /><select value={deviceFilter} onChange={e => setDeviceFilter(e.target.value as any)}><option value="all">All devices</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select></div><div className="branchList">{filteredDevices.length === 0 ? <p className="empty">No devices match this search.</p> : filteredDevices.map(device => <div className="branchRow" key={device.id}><div className="branchSummary"><strong>{device.name}</strong><span>{device.branchName}</span><small>{device.online ? 'Online' : 'Offline'} · {device.active ? 'Active' : 'Inactive'} · {device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Never seen'}</small></div><div className="rowActions"><button onClick={() => editDevice(device)}>Edit</button><button className={device.active ? 'dangerAction' : ''} onClick={() => updateDevice(device, { active: !device.active }, device.active ? 'Tablet deactivated.' : 'Tablet activated.')}>{device.active ? 'Deactivate' : 'Activate'}</button></div></div>)}</div></section>
    </>}

    {activeTab === 'shifts' && <>
      <section className="panel branchFormPanel"><div className="panelHead"><div><h2>Schedule shift</h2><span>Assign an employee to a branch and define working hours.</span></div></div><form onSubmit={addShift} className="shiftForm"><label>Employee<select name="employeeId" required defaultValue=""><option value="" disabled>Select employee</option>{employees.filter(e => e.active).map(employee => <option key={employee.id} value={employee.id}>{employee.firstName} {employee.lastName} · #{employee.employeeNumber}</option>)}</select></label><label>Branch<select name="branchId" required defaultValue=""><option value="" disabled>Select branch</option>{branches.filter(b => b.active).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label>Starts<input name="startsAt" type="datetime-local" required /></label><label>Ends<input name="endsAt" type="datetime-local" required /></label><label>Break minutes<input name="breakMinutes" type="number" min="0" max="720" defaultValue="0" required /></label><button className="primary" type="submit" disabled={!employees.some(e => e.active) || !branches.some(b => b.active)}>Schedule shift</button></form><p className="formHint">Times use the timezone configured on this device. Branch-specific timezone scheduling will be added before international rollout.</p>{shiftMessage && <div className="infoBox">{shiftMessage}</div>}</section>
      <section className="panel"><div className="panelHead"><div><h2>Shift schedule</h2><span>{shifts.filter(s => new Date(s.endsAt).getTime() >= Date.now()).length} upcoming · {shifts.length} total</span></div></div><div className="directoryTools"><input value={shiftSearch} onChange={e => setShiftSearch(e.target.value)} placeholder="Search employee or branch" /><select value={shiftFilter} onChange={e => setShiftFilter(e.target.value as any)}><option value="upcoming">Upcoming & current</option><option value="all">All shifts</option><option value="past">Past shifts</option></select></div><div className="branchList">{filteredShifts.length === 0 ? <p className="empty">No shifts match this view.</p> : filteredShifts.map(shift => { const now=Date.now(),start=new Date(shift.startsAt).getTime(),end=new Date(shift.endsAt).getTime(); const state=now<start?'Upcoming':now<=end?'In progress':'Completed'; return <div className="branchRow" key={shift.id}><div className="branchSummary"><strong>{shift.employeeName}</strong><span>#{shift.employeeNumber} · {shift.branchName}</span><small>{state} · {new Date(shift.startsAt).toLocaleString()} → {new Date(shift.endsAt).toLocaleString()} · {shift.breakMinutes} min break</small></div><div className="rowActions"><button className="dangerAction" onClick={() => deleteShift(shift)}>Delete</button></div></div> })}</div></section>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);