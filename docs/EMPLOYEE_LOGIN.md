# Employee login foundation

The existing dashboard now offers Admin / Manager and Employee sign-in paths. The employee path uses the same deployed API (`VITE_API_URL`), so no new Render service or token secret is needed. Existing worker numbers and PINs are used; managers continue to create workers and reset PINs in Employees.

## Rollout and checks

Merge the pull request into Main and redeploy the existing API and dashboard. The API startup migration creates employee_sessions and its revocation trigger through the existing schema migration. Deploy the API before the dashboard. No seed or environment changes are required.

In Employees, open the employee sign-in link and share that company-specific URL with workers. Its company ID is an identifier, not a credential. Employees without a company link can enter their company ID; their manager provides it.

Check successful login, incorrect PIN, assigned shifts, sign-out, manager PIN reset and worker deactivation. Confirm another company's worker credentials fail on the company link. Employee tokens grant no admin access. Previously issued sessions are deleted by a database trigger after PIN reset or deactivation; reactivation does not restore them.

Sessions expire after 12 hours. Database storage contains token hashes, not raw tokens. Reads are restricted to the authenticated employee and company, with active status and current PIN checked on each request. Responses use Cache-Control: no-store. The IP limiter permits 10 attempts per 15-minute window per API process; multiple replicas would need a shared limiter. Employee sessions use a separate browser storage key from manager sessions.

The older apps/employee and apps/employee-api prototypes are unchanged and are not used by this integrated path. This phase covers account access and shift viewing. Mobile QR check-in/out, configurable tasks, incidents, daily records and encrypted messaging remain subsequent phases.

Automated route tests use Fastify injection and a database stub. Full PostgreSQL migration and live Render verification require the deployed environment.
