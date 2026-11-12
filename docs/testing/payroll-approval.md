# Payroll approval and payslips

Staging branch: `integration/manual-rota-production-2026-11`.
Manager path: **Shifts → Payroll approval and payslips**.

1. Select a closed payroll month and load the review.
2. Resolve listed blockers using compensation history, publication, shift exception reviews and adjustment reviews.
3. Refresh the payroll review, inspect employee gross and net totals across all branches, then approve.
4. Download each employee's PDF. Reloading an approved month retrieves the immutable saved records.

Hourly pay uses the full published scheduled duration, with no break deductions. Eligible approved overtime replaces base hourly pay for those hours. Monthly salaries remain fixed. Missing attendance requires an explicit Worked, Cancelled or Reassignment decision; a Worked decision preserves scheduled pay. Approved bonuses and deductions are reconciled into gross and net amounts. Taxes must be entered as approved deductions; there is no automatic statutory tax calculation or payment execution.

Approval requires the company-local month to have closed. Unpublished/unfinished shifts, unresolved attendance/reassignments, missing verified compensation history, pending adjustments, currency mismatches and negative net pay block approval. Cross-month shifts, shifts spanning rate changes, mid-month salary transitions and historical monthly salaries that differ from the current profile require reconciliation and are blocked rather than silently underpaying. No supported automatic proration policy is assumed.

The approval transaction locks its source tables, recalculates the preview and compares its hash before writing one run and one snapshot per employee. Concurrent duplicate submissions with the same preview hash return the original run. A database or audit failure rolls back the whole run. Identity, source shifts, approved adjustments and amounts are saved with the snapshot, so later source edits do not reprice downloads.

## Validation

- `npm run typecheck`
- `npm run build`
- `SCHEDULING_TEST_DATABASE_URL=<isolated database> npm test`
- New payroll PostgreSQL tests cover adjustments, overtime, negative pay, missing history, stale previews, audit rollback, concurrency, company isolation and immutable PDF downloads.
- Isolated browser check exercises the actual React component against Fastify/PostgreSQL, including open-month blocking, approval and PDF download, at desktop/mobile sizes.

Staging API uses `ATTENDRA_EXPECTED_DATABASE=attendra_staging_db` to reject migrations pointed at a different database. `ATTENDRA_PAYROLL_STAGING_VERIFY=true` runs a deployment check restricted to that exact database: create temporary fixture, review, approve, retrieve snapshot and download PDF, then roll back all fixture data. A failed check stops startup. It is not enabled for production.

Production `Main` and production services are outside this change's deployment scope.
