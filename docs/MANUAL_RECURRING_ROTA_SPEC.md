# Manual weekly/monthly rota and recurrence — approved specification

## Product workflow
1. Manager selects branch and weekly or monthly period, then manually assigns employees, shift start/end times, unpaid breaks, and dates.
2. Manager reviews and publishes the reference rota. A draft rota must never become a recurrence source before approval.
3. Manager optionally enables recurrence: every week or every month, either until stopped or through a specified end date.
4. Future occurrences copy the approved reference pattern into **drafts** for manager review and publication. No automatic publishing.
5. Managers can edit individual occurrences, pause/resume or stop recurrence. Stop must not delete published schedules.
6. Manual creation is the primary workflow; remove or de-emphasize the old auto-generate monthly action only once the replacement is implemented and tested.

## Required data
- rota_templates: id, tenant_id, branch_id, period_type (weekly/monthly), anchor_start_date, timezone, approved_version, status, created_by, created_at, updated_at.
- rota_template_shifts: id, template_id, employee_id, local_date or day_offset, start_local_time, end_local_time, break_minutes, metadata.
- rota_recurrences: id, template_id, cadence, end_mode (until_stopped/on_date), end_date nullable, status (active/paused/stopped), next_period_start, created_by, timestamps.
- rota_occurrences: id, recurrence_id, period_start, template_version, status (draft/published), created_at, unique(recurrence_id,period_start).
- Shift records must retain provenance (occurrence/template) to support idempotent regeneration and audits.

## Scheduling safeguards
- Scope every read/write to tenant and branch with RBAC.
- Check employee branch eligibility, approved leave, existing shifts across branches, duplicate shifts, rest requirements, and working-hour limits.
- Report conflicts and coverage gaps. Do not silently overwrite manager edits or published shifts. Working-hour excess may be a warning rather than a hard stop, according to company policy.
- Generate with an idempotency key and database transaction; rerunning must not duplicate drafts.
- Use branch-local timezone for recurrence boundaries and daylight-saving transitions.
- Weekly recurrence preserves weekdays; monthly recurrence must define explicit calendar-date vs weekday-pattern semantics and flag unmappable dates for review.
- Ensure recurrence generation works when months have 28/29/30/31 days, and when employee eligibility changes.

## UI
- Create Weekly Rota / Create Monthly Rota.
- Repeat this rota checkbox.
- End: Until manager stops / On selected date.
- Preview future occurrences, exceptions and approval status; stop/pause/resume controls.
- Staffing interpretation remains configurable per branch: total distinct employees per day OR minimum simultaneous coverage; this is independent of manual recurrence.

## Acceptance tests
- Weekly and monthly templates created, approved, repeated as drafts, and published after review.
- End-date inclusive behavior, indefinite repetition, pause/resume/stop.
- Idempotency, branch conflicts, leave, employee removal, changed eligibility, editing one occurrence without mutating template.
- Month-end and leap-year mapping, branch timezone/DST, tenant isolation, approval audit log.
- Existing manual shifts and published rotas remain intact during migration.

## Rollout
Implement database migration, API and dashboard on feature branch; run tests, review a PR, then deploy staging. No production rollout before approval.
