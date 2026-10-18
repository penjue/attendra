# Employee Tasks & Incident Reporting — implementation contract

Status: Phase 1 design and security contract. Do not merge until API, UI, migration and integration tests pass.

## Scope
- Managers create tasks for an employee in their own company, optionally tied to a branch and shift.
- Employees see only tasks assigned to their own authenticated employee identity.
- Employees mark tasks in progress or complete; completion is timestamped server-side.
- Employees submit incident reports with category, description, occurrence time and optional shift.
- Managers see and triage incidents within their own company. Incident reports are append-only for employees; managers can update workflow status without altering the original account.
- No media uploads or encrypted messaging in this phase.

## Data model
`employee_tasks`: id UUID PK, company_id UUID NOT NULL FK, employee_id UUID NOT NULL, branch_id UUID NULL, shift_id UUID NULL, title VARCHAR(160) NOT NULL, description TEXT, due_at TIMESTAMPTZ, status CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED')), created_at, updated_at, completed_at. Enforce company-scoped composite foreign keys or equivalent constraints on every employee/branch/shift relationship.

`employee_incidents`: id UUID PK, company_id UUID NOT NULL, employee_id UUID NOT NULL, branch_id UUID NULL, shift_id UUID NULL, category CHECK (category IN ('SAFETY','INJURY','EQUIPMENT','SECURITY','OTHER')), description TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, status CHECK (status IN ('SUBMITTED','UNDER_REVIEW','RESOLVED')), created_at, reviewed_at, reviewed_by. Preserve original report content.

## API
Employee routes use existing `authenticateEmployee` in `apps/api/src/employee-routes.ts`, never accept company_id or employee_id from client input:
- GET /v1/employee/tasks
- PATCH /v1/employee/tasks/:id/status (allow IN_PROGRESS or COMPLETED; reject CANCELLED)
- GET /v1/employee/incidents
- POST /v1/employee/incidents

Manager routes require existing verified admin/manager authorization with company-scoped authorization:
- POST /v1/admin/tasks
- GET /v1/admin/tasks
- GET /v1/admin/incidents
- PATCH /v1/admin/incidents/:id/status

## Acceptance/security criteria
1. Cross-company employee and task IDs return 404; no cross-tenant disclosure.
2. Employees cannot assign tasks, modify others' tasks, or alter original incident content.
3. Branch/shift association must be validated against employee assignment and company.
4. Validate all inputs with Zod, enforce bounded pagination and description lengths.
5. Incident timestamps must be plausible and stored in UTC.
6. Use parameterized SQL, server-side timestamps, and no sensitive incident content in request logs.
7. Schema migration is idempotent, backwards-compatible and tested against existing data.
8. Tests cover authentication, tenant isolation, task transitions, incident submission, invalid input, and database failures.
9. UI shows loading, empty, success and error states, with keyboard/mobile accessibility.
10. Do not deploy automatically before tests and explicit review.

## Rollout
Phase 1: database and API; Phase 2: employee task/incident UI; Phase 3: manager assignment/triage UI; Phase 4: automated tests and staging verification; Phase 5: reviewed merge and release.
