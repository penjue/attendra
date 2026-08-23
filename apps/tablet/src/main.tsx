import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  const [employee, setEmployee] = useState('');
  const [pin, setPin] = useState('');
  return <main className="kiosk">
    <div className="brand">Attendra</div>
    <p className="branch">Demo Branch · Registered tablet</p>
    <section className="card">
      <h1>Welcome</h1><p>Enter your employee number and PIN.</p>
      <label>Employee number<input inputMode="numeric" value={employee} onChange={e=>setEmployee(e.target.value)} placeholder="e.g. 1042" /></label>
      <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={e=>setPin(e.target.value)} placeholder="••••" /></label>
      <div className="actions"><button disabled={!employee||pin.length<4}>Check in</button><button className="secondary" disabled={!employee||pin.length<4}>Check out</button></div>
      <small>Biometric verification will be optional in a later release.</small>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
