# Roadmap

## Now — v0.1
Company setup, branches, employees, registered device, check-in/out, dashboard, PostgreSQL persistence, audit log.

## Next — v0.2
Shift scheduling, late/absence rules, offline queue and sync, attendance correction workflow, hour totals, basic reports/CSV export.

Offline attendance sync is being implemented with authenticated device writes and idempotent client event IDs so reconnect retries do not duplicate attendance records.

## Later
Biometrics + liveness/device adapters, payroll integrations, leave management, advanced analytics, notifications, native mobile clients, more countries.
