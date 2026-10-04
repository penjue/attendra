# Employee QR attendance

## Deployment

Deploy the existing API first, then the dashboard and tablet services from Main. Startup migration adds attendance_qr_challenges and attendance_qr_claims. No employee accounts or existing attendance records are replaced. Refresh both clients after deployment.

The tablet QR links to https://attendra.co.ke by default. For another HQ domain, set VITE_EMPLOYEE_APP_URL in the tablet build environment. For local testing use http://localhost:5173. QR attendance requires online API access; the existing tablet number/PIN flow remains available.

## Use

1. On an activated tablet, select Check-in QR or Check-out QR. Codes refresh every 40 seconds and expire after 60 seconds.
2. In the Employee portal, tap Scan tablet QR and allow the rear camera. If the browser does not support QR detection, use the phone's Camera app and open the link instead.
3. Sign in if needed. Check the branch and action, then confirm. Opening a link or previewing a QR does not write attendance.
4. A success message appears and My shifts refreshes. The record also appears in manager attendance/timekeeping.

If signing in takes longer than the code lifetime, scan the current code again. Camera permission failures display guidance and leave no active camera stream. The token is carried in the URL fragment, then moved to tab-scoped session storage and removed from the address bar. Signing out clears pending QR state.

## Server checks

The tablet must prove its device key to create a code. Only the challenge token appears in the QR. Token hashes and the issuing device-key hash are stored; codes cannot be used after device deactivation, branch deactivation, device reassignment, key reset or expiry. Employees must have a current session for the same company. Device and worker locks plus a unique per-worker claim protect retries. The worker is reauthenticated and code expiry rechecked after locks are acquired.

Check-in requires a shift at the scanned branch within the existing four-hour scheduling window. An open check-in prevents another check-in. Checkout is final for that scheduled shift: both QR and tablet PIN attendance reject another check-in to a shift that has a checkout. Existing attendance history is preserved. Check-out requires an open check-in at the same branch and links to its original scheduled shift. Attendance times come from the API, and check-in uses the existing five-minute early/late grace period. Source is EMPLOYEE_QR and the transaction writes attendance, replay claim and employee audit entry together.

## Verification

Automated Fastify tests use a database stub and cover device authorization, token storage, preview without mutation, server-owned identity/action/time, replay, expired/invalid codes, disabled/reset devices, company isolation, schedule/state validation, revoked sessions, expiry while waiting for locks and rollback on audit failure. Browser checks could not run in the coding environment because the Chromium download failed. Live PostgreSQL locking/migration, visual layout, real phone camera detection and end-to-end Render attendance remain manual checks after merge.

For a live test, schedule a demo worker at the tablet's branch; check in, confirm manager attendance and employee status, scan the same code again, then check out. Try a worker from another company, an expired code, a second check-in and a check-out without an open shift. Confirm the existing tablet number/PIN flow still works.
