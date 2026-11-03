# Manager-approved overtime — implementation contract (staging)

## Policy
- A weekly limit is advisory for scheduling; exceeding it must not silently create payroll overtime.
- Calculate weekly totals per employee across **all branches**, in the company timezone, using the week containing the proposed shift. Cumulative lifetime totals must never trigger a weekly warning.
- Include both draft and published assigned shifts. Handle cross-midnight and week-boundary shifts by allocating hours to the applicable weeks; do not count the whole shift in the starting week.
- Detect whether each proposed assignment would cross the limit; for bulk and recurring generation, show a reviewable list of affected employees and periods before approval. Prevent accidental duplicate approvals when retried.
- Manager can approve or decline each overtime proposal. Declining must not remove previously assigned shifts. For newly generated drafts, keep them pending review rather than silently publishing them.
- Approved overtime pay rate is manager-selected: normal rate, multiplier, or explicit currency-denominated hourly rate. For monthly-salaried workers, manager can specify an independent overtime hourly rate. Validate positive amounts and record currency.
- Preserve employee ID, company ID, shift ID, approving admin ID, approval timestamp, applicable week, regular hours, overtime hours, pay method, rate, and final approved amount in an auditable record. Recalculate or invalidate approvals safely on reassignment, deletion, shift edits, and changes to weekly limits. Do not treat a draft as payable payroll.
- Payroll must show regular and approved overtime separately, and enforce any applicable labor rules and company policy.

## Required rollout sequence
1. Add idempotent migration and a company-scoped overtime approvals table. Verify it executes on **existing staging databases**, not just fresh schema installs.
2. Add API preview and approval endpoints with transactional concurrency protection and authorization.
3. Add confirmation UI to one-off, bulk, and recurring draft generation paths; require explicit manager decision and rate selection.
4. Integrate approved overtime into employee-based payroll across branches, preserving existing payroll logic.
5. Add API and UI tests for week boundaries, simultaneous assignments, branch aggregation, rate options, repeated requests, cancelled drafts, and monthly employees.
6. Deploy and test **staging only**; do not merge to Main or deploy production without explicit approval.

## Current behavior to replace
The scheduling check currently returns WEEKLY_HOURS_EXCEEDED but the draft and generation paths explicitly ignore that result. Consequently no approval is captured. The employee hours summary is cumulative, not a weekly overtime measure.
