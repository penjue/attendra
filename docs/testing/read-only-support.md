# Attendra Workforce read-only support

Staging manager entry: **Support** tab. Staging employee entry: **Attendra support** below the signed-in employee schedule in the dashboard employee portal. Standalone production employee/tablet applications are unchanged.

The assistant has two visibly different modes:

- **Read-only checks and help guides** work without an AI provider key. These are predefined application checks, not AI-generated answers.
- **Live AI chat** calls the server-side OpenAI Responses API only after a key is configured and the user consents. Sharing the selected diagnostic summary is a separate opt-in. It defaults off.

## Staging configuration

Set only on `attendra-api-staging`:

- `ATTENDRA_SUPPORT_ENABLED=true`
- `ATTENDRA_SUPPORT_MODEL=gpt-4.1-mini` (configurable)
- `ATTENDRA_SUPPORT_OPENAI_KEY`: a project API key, entered as a secret in Render, never chat, Git, browser storage or frontend build variables. Configure the provider project's usage controls/budget separately.

The ChatGPT subscription is not used as the application API credential. Without the key, status reports `aiConfigured:false`, chat is disabled with an explicit setup notice, and record checks and knowledge remain usable. Provider credit/auth/rate errors are surfaced safely; configuring a key alone does not prove the provider account can answer.

## Permission and read-only boundary

The backend revalidates active manager identity/company/role or opaque employee session. A manager receives aggregate counts from their company; employees receive their own counts and recent attendance only. No client-supplied company or employee IDs are accepted. The manager payroll topic includes current approval blockers but not employee pay amounts. No names, hashes, tokens, reset links, free-text personnel notes or raw application logs are included in the model's diagnostic context.

Record checks execute predefined SQL inside `REPEATABLE READ READ ONLY` transactions, with a query timeout. The model receives no database connection, arbitrary SQL capability, tool functions, write endpoints, browsing or messaging tools. It can guide a user to a workflow but cannot approve payroll, reset a PIN, change attendance, activate devices or contact support.

Messages remain in component memory, capped at 20 visible messages; at most six prior messages are sent per request. Conversations are not written to the Attendra database or browser storage. The provider request uses `store:false`; this does not claim zero provider retention. Common credential patterns are redacted as a precaution; users must not type secrets. User opt-in covers sending their question and recent messages to OpenAI; live diagnostic sharing is opt-in separately.

Requests are bounded (2,000-character messages, 800 output tokens, 25-second provider timeout), rate limited to 20 checks/chat requests per actor per 15 minutes, one active request per actor and four concurrent requests per process. These in-memory limits suit the current single-instance staging service; a shared limiter is required before multiple instances. They are not a monthly billing cap.

Knowledge and model output are rendered as plain text. Diagnostic sources and knowledge sources appear with answers. Prompt instructions treat user text/history/record values as untrusted; access boundaries do not rely on the model following instructions. AI answer accuracy still needs evaluation with the real provider after credentials are configured.

If unresolved, **Copy support summary** copies visible messages and selected checks to the user's clipboard. The user reviews and decides whether to share it with a manager/customer care. No automated handover or outgoing message is sent.

## Validation

`npm run typecheck`, `npm run build`, and `SCHEDULING_TEST_DATABASE_URL=<isolated database> npm test`.

Support integration tests use real PostgreSQL for company isolation, employee-only data, revoked sessions, strict request selection, database write rejection, consent, missing-provider handling and redaction. The provider contract is tested with mocked responses; these tests are not a live model-quality evaluation. The existing staging startup verification additionally runs an authenticated support diagnostic check on a temporary company before rolling back all fixtures. Production is not deployed or configured by this change.

Provider contract: https://developers.openai.com/api/reference/resources/responses/methods/create
Model reference: https://developers.openai.com/api/docs/models/gpt-4.1-mini
