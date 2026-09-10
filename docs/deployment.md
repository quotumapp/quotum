# Deployment and configuration

- Document kind: Current behavior
- Sources: [runtime settings](../src/env.ts), [merchant settings](../src/platform/config.ts), [encryption keys](../src/platform/connections/cipher.ts).
## Container image

The [Dockerfile](../Dockerfile) builds a multi-stage image on `oven/bun:1.4.2` containing `src/`,
`migrations/`, and production dependencies. It listens on `PORT` (default `3000`) and runs
`bun run src/index.ts`.

```sh
docker build -t quotum-api:0.9.1 \
  --build-arg BUILD_VERSION=0.9.1 --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" .

docker run --rm --env-file .env -p 3000:3000 quotum-api:0.9.1
```

Run migrations from the same image before starting a new version:

```sh
docker run --rm --env-file .env quotum-api:0.9.1 bun run migrate
```

## Required variables

Copy [`.env.example`](../.env.example) and fill in real values. The service refuses to start when a
required value is missing or unsafe for the selected environment.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_URI` | Direct Postgres connection string. Neon-compatible Postgres works. |
| `BILLING_ENV` | `development`, `test`, or `production` (default). Production enforces HTTPS projection and Stripe URLs and requires the operator key; the merchant settings below are required in every environment. |
| `BILLING_OPERATOR_API_KEY` | Operator credential for catalog publication, replay, reconciliation, and admin metrics. At least 16 characters, separate from project credentials. Required in production. |
| `QUOTUM_SECRETS_KEY_ID`, `QUOTUM_SECRETS_KEY_BASE64` | Identifier and base64 32-byte AES key that encrypts stored provider and projection connections. Keep the key outside Postgres and its backups. Rotate with `bun run connections:rotate-secrets`. |
| `MERCHANT_ORIGIN`, `MERCHANT_PUBLIC_URL` | Merchant origin and public/legal-page URL. Both must be explicitly set to nonblank values in production, including when `BILLING_ENV` is unset. Development and test defaults are `https://app.quotum.dev` and `https://quotum.dev`. The merchant origin must be exact HTTPS outside tests. |
| `QUOTUM_AUTH_SECRET` | Operator-owned secret for Quotum sessions and token HMACs, at least 32 characters. Never reuse another secret. |
| `MERCHANT_TERMS_VERSION`, `MERCHANT_PRIVACY_VERSION` | Approved legal document versions. Signup outside test mode refuses draft versions. |
| `QUOTUM_EMAIL_PROVIDER` | Required explicit choice: `cloudflare` or `resend`. No default or automatic failover. |
| `QUOTUM_EMAIL_FROM` | Quotum's sender email address, from a domain verified with the selected provider. |
| `QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID`, `QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN` | Required only for Cloudflare Email Service. |
| `QUOTUM_EMAIL_RESEND_API_KEY` | Required only for Resend. Use a key permitted to send from the configured domain. |
| `MERCHANT_SIGNUP_ENABLED` | Defaults to `true`; set `false` to close registration. |
| `MERCHANT_GOOGLE_CLIENT_ID`, `MERCHANT_GOOGLE_CLIENT_SECRET` | Optional Google sign-in. Register `https://<merchant-origin>/api/auth/callback/google`. |

Merchant authentication is always on. There is no switch to run the service without it, and the
process refuses to start until the settings above validate, even with signup disabled. Only
`BILLING_ENV=test` permits absent email configuration, and runtime wiring still requires an injected
capture mailer. Explicit partial configuration is rejected in tests too. SMTP is not an available
configuration selector. Close signup explicitly until the deployment is ready.

### Quotum-owned email delivery

These are service-operator settings, not merchant registration fields or customer integrations.
Merchants register their recipient email address; Quotum sends verification, password reset, OTP,
invitation and invite-request messages through the selected adapter. Templates and authentication
rules are independent of the provider.

Cloudflare example:

```dotenv
QUOTUM_EMAIL_PROVIDER=cloudflare
QUOTUM_EMAIL_FROM=no-reply@example.com
QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID=CHANGE_ME
QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN=CHANGE_ME
```

Resend example (no Cloudflare credentials needed):

```dotenv
QUOTUM_EMAIL_PROVIDER=resend
QUOTUM_EMAIL_FROM=no-reply@example.com
QUOTUM_EMAIL_RESEND_API_KEY=CHANGE_ME
```

Onboard the sender domain with the selected provider before using production authentication.
Follow [Cloudflare's email sending setup](https://developers.cloudflare.com/email-service/get-started/)
or [Resend's domain verification](https://resend.com/docs/dashboard/domains/introduction), including
provider-required DNS records and the domain's SPF, DKIM and DMARC policy. Store API credentials
and `QUOTUM_AUTH_SECRET` in the deployment secret manager; never collect them in signup forms.

Both adapters use HTTPS, a ten-second timeout per request and at most three attempts. HTTP 429/5xx
responses retry with bounded backoff (250/500 ms, or numeric Retry-After capped at five seconds).
Other failures return the sanitized `EMAIL_DELIVERY_FAILED` error. Resend reuses one idempotency key
within a send's retries; each new send gets a fresh key. Provider acceptance does not establish inbox
delivery. CI uses synthetic transports and capture mailers, not external inboxes.

### Upgrade from the merchant-prefixed settings

This is a breaking configuration rename; old names are rejected even if new names are also set:

| Retired setting | Replacement |
| --- | --- |
| `MERCHANT_AUTH_SECRET` | `QUOTUM_AUTH_SECRET` |
| `MERCHANT_EMAIL_FROM` | `QUOTUM_EMAIL_FROM` |
| `MERCHANT_EMAIL_ACCOUNT_ID` | `QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID` |
| `MERCHANT_EMAIL_API_TOKEN` | `QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN` |

Prepare the new configuration and roll it out together with the new application version. Add
`QUOTUM_EMAIL_PROVIDER` explicitly. Preserve the auth secret's exact value when renaming it;
renaming must not rotate sessions or token HMACs. Remove retired keys from the new process's
injected environment, and retain the previous configuration securely for rollback with the old
image. If the deployment uses a shared mutable Secret, coordinate the switch so old instances
cannot restart against new-only settings. This change needs no database migration.



A fresh deployment needs no customer bootstrap. Start the service, then let merchants onboard
through the merchant application and configure providers and projections under **Integrations**.
Each environment is configured independently: save a draft, verify provider access or the signed
projection challenge, then commit. Production commits require a fresh step-up grant. Changes take
effect without restarts, and one customer's setup never affects global readiness.

The `platform:bootstrap` manifest used in the [quickstart](quickstart.md) remains available as an
operator fixture for development and internal environments; it is not a sign-up prerequisite. The
bootstrap is empty-or-exact and idempotent: it refuses undeclared rows or topology drift, and
`--check` exits nonzero until both the topology and every declared credential exist.

## Merchant proxy service principal

Browsers never receive billing credentials. A separate merchant proxy forwards allowlisted
`/api/auth`, `/api/platform`, and scoped `/api/billing` operations with a database-backed service
principal. Create it once after migrations:

```sh
bun run scripts/merchant-service-principal.ts <worker-name>
```

Configure merchant authentication before running the command. The token is printed exactly once;
store it as the proxy's `MERCHANT_SERVICE_TOKEN`, alongside its `MERCHANT_API_URL`. It is never a
browser credential. The command refuses an existing name. This principal is required for app
requests, not for global `/ready` to report database/schema health.

## Optional variables

Defaults in parentheses.

- `BILLING_AUTH_MODE=api_key|gateway` (`api_key`). Use `gateway` only when a trusted gateway
  enforces access to non-webhook `/v1/*` routes and sends `x-billing-project-key`; it also requires
  `BILLING_TRUST_GATEWAY_PROJECT_HEADER=true`.
- `BILLING_TRUST_PROXY_HEADERS=true|false` (`false`). When `false`, rate-limit keys ignore
  `cf-connecting-ip` and `x-forwarded-for`. Enable only behind trusted ingress that strips client-supplied
  forwarding headers; the flag itself does not authenticate a proxy.
- `BILLING_POSTGRES_PREPARED_STATEMENTS=true|false` (`true`). Named prepared statements let the
  driver pipeline the independent statements the metering path issues together. Set `false` only
  behind a transaction-mode pooler that cannot hold prepared statements, such as PgBouncer before
  1.21 or one configured without `max_prepared_statements`; the hot path then runs its statements
  one round trip at a time.
- `BILLING_WORKER_ID` (generated).
- `BILLING_WORKER_POLL_INTERVAL_MS` (`5000`).
- `BILLING_PROJECTION_SYNC_MAX_ATTEMPTS` (`10`).
- `BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS` (`10`),
  `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS` (`5000`).
- `BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS` (`10`),
  `BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS` (`60000`),
  `BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS` (`21600000`).
- `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` (`60000`).
- `BILLING_RATE_LIMIT_WINDOW_MS` (`60000`), `BILLING_VERIFY_RATE_LIMIT_PER_WINDOW` (`120`),
  `BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW` (`600`), `BILLING_METERING_RATE_LIMIT_PER_WINDOW`
  (`6000`), `BILLING_ADMIN_RATE_LIMIT_PER_WINDOW` (`60`).
- `SENTRY_DSN` (unset disables Sentry), `SENTRY_ENABLE_LOGS` (`true`),
  `SENTRY_TRACES_SAMPLE_RATE` (`0.01`), `SENTRY_LOG_LEVEL` (`warn`),
  `SENTRY_CAPTURE_EXPECTED_ERRORS` (`false`).

Removed and rejected when supplied: `BILLING_PROJECT_RUNTIME_JSON`, `BILLING_PROJECTS_JSON`, and
`BILLING_PROJECTION_ADAPTER`. Provider and projection settings live in encrypted, versioned
connections owned by the merchant platform.

## Encryption-key rotation

Deploy a new active key while retaining the old key in the paired
`QUOTUM_SECRETS_PREVIOUS_KEY_ID`/`QUOTUM_SECRETS_PREVIOUS_KEY_BASE64` settings. Run
`bun run connections:rotate-secrets` against the target database and verify every envelope now uses
the active key before retiring the previous runtime key. Keep keys needed by retained backups in
recovery secret storage. Rotation is restartable; missing or wrong keys fail closed.

## Authentication

In `api_key` mode, trusted backends send a database-issued project credential as
`Authorization: Bearer <credential>`. Operator routes additionally require `X-Billing-Operator-Key`,
and audited mutations require `X-Billing-Actor`. Provider webhooks are outside project
authentication and rely on provider signature or token verification.

In `gateway` mode, billing-level key checks are disabled for non-webhook `/v1/*` routes only when
`BILLING_TRUST_GATEWAY_PROJECT_HEADER=true`; the gateway must enforce access and send
`x-billing-project-key`.

## Test entrypoints

`bun run test:stripe-entrypoint` starts the service with an in-memory connection fixture and a
network-free fake Stripe client. It requires `BILLING_ENV=test`, `BILLING_TEST_FAKE_STRIPE=true`,
`QUOTUM_AUTH_SECRET`, and the two legal versions; it refuses external provider traffic and keeps
merchant mail in memory instead of sending it. It accepts
`BILLING_TEST_FAKE_STRIPE_PAYMENT_BEHAVIOR=succeeded|action_required|retryable_failure`,
`BILLING_TEST_FAKE_STRIPE_DEFAULT_PAYMENT_METHOD=missing`, and
`BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON` for deterministic worker scenarios. Never set
`BILLING_TEST_*` or `MERCHANT_TEST_MODE` in a deployed service.
