# Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Proxy punching / shared PINs | High | Optional biometric verification, device binding, audit events |
| Poor branch internet | High | Offline queue with idempotent server sync |
| Cross-company data exposure | Critical | Tenant scoping in every query, RBAC, tests, separate keys |
| Biometric/privacy non-compliance | Critical | Optional biometrics, DPIA support, data minimisation, template-only storage where supported |
| Incorrect payroll hours | High | Immutable raw events, rule versioning, review/approval workflow |
| Device theft/tampering | Medium | Device registration, key rotation, remote revoke, kiosk mode |
| Country-specific differences | Medium | Country configuration layer rather than code forks |
