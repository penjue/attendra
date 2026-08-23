# Attendra

Attendra is a global-ready, multi-tenant workforce attendance and shift-management platform. It is being built UK-first with Kenya as the second target market, while keeping one configurable codebase for future countries.

## v0.1 goal
One company can create a branch and employee, record an employee check-in from a registered tablet client, and see that attendance event on the headquarters dashboard.

## Repository layout
- `apps/api` — TypeScript backend API
- `apps/dashboard` — headquarters/admin React dashboard
- `apps/tablet` — tablet-first attendance client (PWA for v0.1)
- `packages/shared` — shared types and validation contracts
- `database` — PostgreSQL schema
- `docs` — product charter, architecture, decisions and roadmap
- `.github/workflows` — CI checks

## Local start
1. Copy `.env.example` to `.env`.
2. Run `npm install`.
3. Start the API: `npm run dev:api`.
4. Start dashboard: `npm run dev:dashboard`.
5. Start tablet: `npm run dev:tablet`.

The v0.1 tablet is a PWA so it can run full-screen on Android tablets immediately. A native Flutter client can later consume the same API without changing the backend contract.
