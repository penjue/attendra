# Architecture v0.1

## Components
- Tablet client: full-screen PWA for initial pilot; later native client may use the same API.
- API: TypeScript/Fastify, stateless HTTP service.
- Database: PostgreSQL with company IDs on tenant-owned records.
- Dashboard: React/Vite web app for headquarters and managers.
- Shared contracts: TypeScript types/validation shared across clients.

## Data path
Tablet -> API authentication/validation -> PostgreSQL -> attendance evaluation -> dashboard/reporting.

## Future services
Offline sync queue, notifications, biometrics adapter, payroll exports, country rules, integrations.
