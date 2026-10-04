import React, { useEffect, useRef, useState } from 'react';

function tokenFromLink(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== location.origin || url.searchParams.get('role') !== 'employee') return '';
    const token = new URLSearchParams(url.hash.slice(1)).get('attendanceQr') || '';
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
  } catch { return ''; }
}
function readPending() {
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('attendanceQr');
  if (fromUrl && /^[A-Za-z0-9_-]{43}$/.test(fromUrl)) {
    sessionStorage.setItem('attendra_pending_qr', fromUrl);
    history.replaceState({}, '', location.pathname + location.search);
    return fromUrl;
  }
  return sessionStorage.getItem('attendra_pending_qr') || '';
}
export function captureAttendanceQr() { return readPending(); }
const errors: Record<string, string> = {
  QR_EXPIRED_OR_UNAVAILABLE: 'This QR expired or is unavailable for your company. Scan the current code on the tablet.',
  ALREADY_CHECKED_IN: 'You are already checked in. Use the check-out QR when your shift ends.',
  NO_OPEN_CHECK_IN: 'You need to check in before checking out.',
  CHECK_OUT_AT_ORIGINAL_BRANCH: 'Check out using a tablet at the branch where you checked in.',
  NO_SCHEDULED_SHIFT: 'No matching shift is scheduled at this branch. Ask your manager to check your schedule.',
  EMPLOYEE_AUTH_REQUIRED: 'Your session ended. Sign out and sign in again.',
  INVALID_QR_CODE: 'Scan an Attendra attendance QR from the tablet.'
};
export function EmployeeQr({ api, token, timeZone, onRecorded }: { api: string; token: string; timeZone: string; onRecorded: () => void }) {
  const [pending, setPending] = useState(readPending);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{ action: string; branchName: string; expiresAt: string } | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const accept = (value: string) => {
    const qrToken = tokenFromLink(value);
    if (!qrToken) { setError(errors.INVALID_QR_CODE); return false; }
    sessionStorage.setItem('attendra_pending_qr', qrToken); setPending(qrToken); setRevision(value => value + 1); setMessage(''); setError(''); setScanning(false); return true;
  };
  useEffect(() => {
    if (!pending) { setPreview(null); return; }
    const abort = new AbortController(); setPreview(null); setError('');
    (async () => { try {
      const response = await fetch(`${api}/v1/employee/attendance/qr/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ qrToken: pending }), signal: abort.signal });
      const data = await response.json(); if (!response.ok) throw Error(errors[data.error] || 'Unable to check QR. Please scan again.');
      if (!abort.signal.aborted) setPreview(data);
    } catch (failure: any) { if (!abort.signal.aborted) setError(failure.message || 'Check your connection and scan again.'); } })();
    return () => abort.abort();
  }, [pending, api, token, revision]);
  useEffect(() => {
    if (!scanning) return;
    let cancelled = false, stream: MediaStream | undefined, timer: number | undefined;
    (async () => { try {
      const Detector = (window as any).BarcodeDetector;
      if (!Detector || !(await Detector.getSupportedFormats()).includes('qr_code')) throw Error('Use your phone’s Camera app to scan the tablet QR and open the link.');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
      const element = video.current; if (!element) throw Error('Camera unavailable. Please try again.');
      element.srcObject = stream; await element.play();
      const detector = new Detector({ formats: ['qr_code'] });
      const scan = async () => {
        if (cancelled) return;
        try { const results = await detector.detect(element); if (!cancelled && results.some((result: any) => accept(result.rawValue))) return; } catch { /* A frame may not yet be ready. */ }
        if (!cancelled) timer = window.setTimeout(scan, 200);
      }; scan();
    } catch (failure: any) { if (!cancelled) { setError(failure.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access or scan with your phone’s Camera app.' : failure.message || 'Camera unavailable. Use your phone’s Camera app.'); setScanning(false); } } })();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); };
  }, [scanning]);
  const confirm = async () => {
    if (busy || !preview) return; setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${api}/v1/employee/attendance/qr`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ qrToken: pending }) });
      const data = await response.json(); if (!response.ok) throw Error(errors[data.error] || 'Unable to record attendance. Check your connection and retry.');
      setMessage(`${data.event.action === 'CHECK_IN' ? 'Check-in' : 'Check-out'} ${data.duplicate ? 'already recorded' : 'recorded'} at ${new Date(data.event.occurredAt).toLocaleTimeString([], { timeZone })}.`);
      sessionStorage.removeItem('attendra_pending_qr'); setPending(''); setPreview(null); onRecorded();
    } catch (failure: any) { setError(failure.message || 'Unable to record attendance. Please retry.'); } finally { setBusy(false); }
  };
  return <section className="panel"><h2>Start or end my shift</h2><p>Scan the attendance QR displayed on your branch tablet.</p>
    {!scanning ? <button className="primary" disabled={busy} onClick={() => { setScanning(true); setError(''); }}>Scan tablet QR</button> : <><video ref={video} playsInline muted style={{ width: '100%', maxWidth: 480, borderRadius: 12 }} /><button className="linkButton" onClick={() => setScanning(false)}>Stop camera</button></>}
    <p><small>You can also scan with your phone’s Camera app and open the link.</small></p>
    {preview && <div className="infoBox"><strong>{preview.action === 'CHECK_IN' ? 'Check in' : 'Check out'} · {preview.branchName}</strong><p>Confirm to record attendance for your account.</p><button className="primary" disabled={busy} onClick={confirm}>{busy ? 'Recording…' : preview.action === 'CHECK_IN' ? 'Confirm check-in' : 'Confirm check-out'}</button><button className="linkButton" disabled={busy} onClick={() => { sessionStorage.removeItem('attendra_pending_qr'); setPending(''); }}>Cancel</button></div>}
    {pending && !preview && !error && <p>Checking QR…</p>}
    {message && <div className="infoBox" role="status">{message}</div>}{error && <div className="errorBox" role="alert">{error}</div>}
  </section>;
}
