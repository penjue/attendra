# Product Decisions Log

| ID | Decision | Reason |
|---|---|---|
| D-001 | Product name: Attendra | Working brand for standalone attendance platform |
| D-002 | UK first, Kenya second | Focus launch while preserving international architecture |
| D-003 | One multi-tenant codebase | Prevent country/client forks |
| D-004 | PostgreSQL system of record | Strong relational integrity and reporting |
| D-005 | PIN is baseline authentication | Simple and hardware independent |
| D-006 | Biometrics optional | Reduces proxy punching while preserving non-biometric alternative |
| D-007 | No silent attendance edits | Corrections must remain auditable |
| D-008 | PWA tablet client for v0.1 | Fastest deployable tablet pilot; native client remains possible via API |
