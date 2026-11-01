# Staging recurring-rota worker

This is an **opt-in** scheduled process. Do not enable it on the production service.

## Preconditions
1. Apply the recurring rota schema to the staging PostgreSQL database.
2. Complete manager UI and end-to-end staging acceptance tests.
3. Confirm that the staging database is isolated from production.
4. Set the same ADMIN_TOKEN_SECRET used by the staging API.

## Scheduled command
Run from the repository root after building the API:

```sh
npm --workspace @attendra/api run rota:worker
```

Required environment variables:

- `DATABASE_URL`: staging PostgreSQL connection string
- `ADMIN_TOKEN_SECRET`: staging API token secret
- `ATTENDRA_ROTA_WORKER_ENABLED=true`: explicit opt-in
- `ATTENDRA_ROTA_WORKER_ENV=staging`: production execution guard

A hosting scheduler (such as a staging Render cron service) must invoke this command. **No schedule is configured or activated by this commit.**

## Behaviour and limits
- Looks for active, approved recurrences due within seven days.
- Processes at most 25 recurrences per invocation.
- Uses a transaction and row lock per recurrence; duplicate periods are prevented by a database unique constraint.
- Generates **unpublished** shifts only. Managers must review and publish them.
- Conflicts and employee absences roll back the affected period; the worker logs the issue and returns a nonzero exit code.
- Paused and stopped recurrences are not processed.

## Acceptance checks before enabling a schedule
- Run the command once against isolated staging test data and verify only draft shifts were created.
- Repeat the command and verify no duplicate periods or shifts.
- Verify pause, stop, end date, employee leave and overlapping shifts.
- Confirm managers can publish drafts and that previously published shifts are preserved.
- Verify monitoring and alerting on failed runs.

## Known limitations
- No manager notification service or automatic conflict resolution yet.
- The current date horizon is evaluated in the database timezone, not the branch timezone.
- A monthly period with template offsets beyond the target month is rejected for manual correction.
- The worker currently prepares one period per recurrence per invocation; schedule frequency determines catch-up speed.
