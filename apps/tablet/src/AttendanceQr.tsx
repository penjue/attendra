import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
type Config = { companyId: string; branchId: string; deviceId: string; deviceKey?: string };
type Code = { image: string; expiresAt: number; action: 'CHECK_IN' | 'CHECK_OUT' };
export function AttendanceQr({ config, api }: { config: Config; api: string }) {
  const [action, setAction] = useState<'CHECK_IN' | 'CHECK_OUT'>('CHECK_IN');
  const [code, setCode] = useState<Code | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!config.deviceKey) return;
    const abort = new AbortController();
    setCode(null); setError('');
    const refresh = async () => {
      try {
        const response = await fetch(`${api}/v1/devices/attendance-qr`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
          body: JSON.stringify({ ...config, action })
        });
        if (!response.ok) throw Error(response.status === 429 ? 'Please wait a few seconds, then tap Retry.' : 'Unable to display QR. Check this tablet’s connection and registration.');
        const data = await response.json();
        const env = (import.meta as any).env;
        const url = new URL(env.VITE_EMPLOYEE_APP_URL || 'https://attendra.co.ke');
        url.searchParams.set('role', 'employee'); url.searchParams.set('company', config.companyId);
        url.hash = new URLSearchParams({ attendanceQr: data.qrToken }).toString();
        const image = await QRCode.toDataURL(url.toString(), { width: 280, margin: 2, errorCorrectionLevel: 'M' });
        if (!abort.signal.aborted) { setCode({ image, expiresAt: new Date(data.expiresAt).getTime(), action: data.action }); setError(''); }
      } catch (failure: any) { if (!abort.signal.aborted) { setCode(null); setError(failure.message || 'QR unavailable. Please retry.'); } }
    };
    refresh(); const timer = window.setInterval(refresh, 40000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [api, config.companyId, config.branchId, config.deviceId, config.deviceKey, action, retry]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return <section className="card" style={{ marginTop: 20, textAlign: 'center' }}><h2>Use your phone</h2><p>Scan this QR to {action === 'CHECK_IN' ? 'start' : 'end'} your shift.</p>
    <div className="actions"><button onClick={() => setAction('CHECK_IN')} className={action === 'CHECK_IN' ? '' : 'secondary'} aria-pressed={action === 'CHECK_IN'}>Check-in QR</button><button onClick={() => setAction('CHECK_OUT')} className={action === 'CHECK_OUT' ? '' : 'secondary'} aria-pressed={action === 'CHECK_OUT'}>Check-out QR</button></div>
    {!config.deviceKey ? <p>Ask your manager to activate this tablet before using phone QR attendance.</p> : code && code.expiresAt > now && code.action === action ? <><img src={code.image} alt={`Scan to ${action === 'CHECK_IN' ? 'check in' : 'check out'}`} width={280} height={280} style={{ maxWidth: '100%', height: 'auto', marginTop: 12 }} /><p>Refreshes automatically · {Math.max(0, Math.ceil((code.expiresAt - now) / 1000))} seconds remaining</p></> : <p>{error || 'Preparing a fresh QR…'}</p>}
    {error && <button className="secondary" onClick={() => setRetry(value => value + 1)}>Retry</button>}
    <small>Open the scanned link, sign in if asked, then confirm attendance. QR attendance needs an internet connection.</small>
  </section>;
}
