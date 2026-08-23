import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return <main className="shell">
    <header><div><span className="eyebrow">ATTENDRA HQ</span><h1>Workforce overview</h1></div><span className="badge">v0.1</span></header>
    <section className="grid">
      <article><strong>0</strong><span>Checked in now</span></article>
      <article><strong>0</strong><span>Late today</span></article>
      <article><strong>0</strong><span>Absent</span></article>
      <article><strong>0</strong><span>Offline devices</span></article>
    </section>
    <section className="panel"><h2>Live attendance</h2><p>The first persisted tablet check-in will appear here in milestone 1.5.</p></section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
