# Employee calendars and manager scheduling

Employees can switch between Today, Week and Month. Dates use the company timezone. Overnight shifts appear on each occupied date, and a midnight end does not occupy the next day. Only published shifts appear; draft shifts do not contribute to employee attendance or scheduled payroll hours. Availability exceptions are shown to the employee without the manager's absence category. Schedule notices are in-app updates, not push notifications or emails.

The manager's Shifts tab has a weekly employee/day grid with branch and name/number/role filters. Select employees once for bulk one-off drafts or repeating weekly patterns. Pattern times use the branch timezone; earlier end times mean overnight shifts. Equal start/end times and breaks longer than the shift are rejected.

Patterns are reusable instructions, not a background job. Generate up to 62 calendar days for selected patterns, review the drafts, then publish selected shifts. Repeated generation keeps existing pattern/date shifts, including shifts reassigned to a replacement employee. Stop a pattern to prevent future generation; previously generated shifts stay in place. Delete a draft and regenerate it to change a draft's times.

Record absence, injury, leave or a day off as inclusive whole dates in the company timezone. These exceptions preserve the recurring pattern. Existing shifts are marked Needs cover; newly generated shifts for unavailable staff remain drafts that cannot publish until the manager removes the exception or assigns cover. Other conflicts (overlap, branch eligibility, weekly hours, past dates) skip the affected generated shifts and are listed for review.

Scheduling rules define each employee's role, eligible branches and maximum weekly hours (40 by default, editable to 168). Empty eligible branches means all company branches. Cover suggestions match the original employee's role when set, exclude unavailable or overlapping staff, and enforce branch eligibility and hours. They are rechecked inside the assignment transaction. Attendance already recorded prevents reassignment. The manager explicitly chooses the replacement, leaving the repeating pattern unchanged.

Weekly hours include published and draft shifts, subtract configured breaks, and attribute the whole shift to the Monday-based company week containing its start. This is a scheduling limit, not a jurisdiction-specific payroll or rest-rule engine. Access follows existing company-scoped manager authentication.

## Verification

`npm run typecheck`, `npm run build` and `npm test` cover the existing employee/QR flows, cover eligibility, date boundaries and timezone behavior. CI runs a PostgreSQL 16 service for scheduling integration tests: schema replay, company isolation, unpublished visibility, idempotent generation, availability, cover revalidation, weekly limits and concurrent draft creation.

For local database integration, set `SCHEDULING_TEST_DATABASE_URL` to a disposable test database before `npm test`. The test applies the schema and removes its own test companies. Without that variable, the PostgreSQL integration suite skips.

After deployment, test in the UI:

1. Create a pattern for multiple employees and generate a future week. Verify employees cannot see its drafts.
2. Review and publish. Verify employee Week and Month views show the correct branches and local times.
3. Add leave on one published shift date. Verify Needs cover, find a replacement and assign cover. Verify both employees receive in-app schedule updates.
4. Generate that date again. Verify the replacement is kept and no duplicate shift appears.
5. Generate another unavailable pattern date. Verify the shift stays a cover draft and cannot publish before resolution.
6. Try conflicting shifts, mismatched roles, a restricted branch and exceeding weekly hours. Verify the planner rejects or skips them clearly.
7. Verify PIN and QR check-in/out still work for a published shift; completed shifts still cannot restart.
