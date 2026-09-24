# Deployment and configuration

- Document kind: Current behavior
- Sources: [runtime settings](../src/env.ts), [merchant settings](../src/platform/config.ts), [encryption keys](../src/platform/connections/cipher.ts).
## Container image

The [Dockerfile](../Dockerfile) builds a multi-stage image on `oven/bun:1.4.2` containing `src/`,
`migrations/`, `contracts/`, the `quotum` operator CLI, and production dependencies. It listens on
`PORT` (default `3000`) and runs `bun run src/index.ts`.

Released images are published to `ghcr.io/quotumapp/quotum` for `linux/amd64` and `linux/arm64`.
Each [GitHub Release](https://github.com/quotumapp/quotum/releases) records the image digest in its
`image.json` asset; pin
deployments to it rather than to the moving `X.Y` or `latest` tags. To build locally instead:

```sh
build_commit=$(git rev-parse HEAD)
build_version="0.0.0-dev.$build_commit"
docker build -t quotum-api:local \
  --build-arg BUILD_VERSION="$build_version" --build-arg BUILD_COMMIT="$build_commit" .

docker run --rm --env-file .env -p 3000:3000 quotum-api:local
```

Run migrations from the same image before starting a new version:

```sh
docker run --rm --env-file .env quotum-api:local quotum migrate
```

### Operator CLI

Operator commands ship in the image as `quotum` on its `PATH`. Run them in a one-off container
(`docker run --rm --env-file .env <image> quotum <command>`) or in a running one (`docker exec`). In
a source checkout, `bun run quotum <command>` is equivalent, and the existing package scripts keep
working. Each command runs as its own process, reads its settings from the environment only (never a
`.env` file), and exits with that command's status. `quotum <command> --help` prints a command's
usage and the settings it reads without running it; an unknown command or unexpected arguments exit
`64` before anything runs.

| Command | Purpose |
| --- | --- |
| `quotum migrate` / `quotum migrate status` | Apply pending migrations, or verify the applied checksums. |
| `quotum bootstrap --check` / `--apply [--credentials-out <path>]` | The [platform bootstrap](#first-start). |
| `quotum catalog provision` | Import the store products in `BILLING_CATALOG_IMPORT_JSON`. |
| `quotum catalog status` / `diff <file>` / `push <file>` | [Catalog automation](api.md#catalog-publication) over HTTP. |
| `quotum connections rotate-secrets` | [Encryption-key rotation](#encryption-key-rotation). |
| `quotum merchant service-principal <name>` | The [merchant proxy service principal](#merchant-proxy-service-principal). |
| `quotum mcp` | The read-only [stdio MCP server](mcp.md#run-over-stdio). |
| `quotum healthcheck` | Exit `0` only when this instance's `/ready` answers `200`, for container health checks. |
| `quotum init` | Print a newly generated `QUOTUM_SECRETS_KEY_*`, `QUOTUM_AUTH_SECRET` and `BILLING_OPERATOR_API_KEY`. |
| `quotum version`, `quotum help` | Build version and command list. |

`quotum init` prints secrets on purpose: redirect it to a file only you can read
(`umask 077; quotum init > quotum.env`) and move the values to your secret manager. The image's
working directory is not writable by its `bun` user, so point `--credentials-out` at a mounted
directory that user can write, or at `/tmp` in the running container, and copy the file out.

## Required variables

Copy [`.env.example`](../.env.example) and fill in real values. The service refuses to start when a
required value is missing or unsafe for the selected environment.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_URI` | Direct Postgres connection string. Neon-compatible Postgres works. |
| `BILLING_ENV` | `development`, `test`, or `production` (default). Production requires the operator key. Projection receivers and Stripe return URLs need HTTPS in every environment; only a headless deployment can approve [private receivers](providers.md#private-receivers-headless-only). The merchant settings below are required in every environment unless `QUOTUM_MERCHANT_ENABLED=false`. |
| `BILLING_OPERATOR_API_KEY` | Operator credential for catalog publication, replay, reconciliation, and admin metrics. At least 16 characters, separate from project credentials. Required in production. |
| `QUOTUM_SECRETS_KEY_ID`, `QUOTUM_SECRETS_KEY_BASE64` | Identifier and base64 32-byte AES key that encrypts stored provider and projection connections. Keep the key outside Postgres and its backups. Rotate with `quotum connections rotate-secrets`. |
| `QUOTUM_MERCHANT_ENABLED` | `true` (default) runs the merchant platform. `false` runs [headless](#headless-mode) and makes every setting below optional. |
| `MERCHANT_ORIGIN`, `MERCHANT_PUBLIC_URL` | Merchant origin and public/legal-page URL. Both must be explicitly set to nonblank values in production, including when `BILLING_ENV` is unset. Development and test defaults are `https://app.quotum.dev` and `https://quotum.dev`. The merchant origin must be exact HTTPS outside tests. |
| `QUOTUM_AUTH_SECRET` | Operator-owned secret for Quotum sessions and token HMACs, at least 32 characters. Never reuse another secret. |
| `MERCHANT_TERMS_VERSION`, `MERCHANT_PRIVACY_VERSION` | Approved legal document versions. Signup outside test mode refuses draft versions. |
| `QUOTUM_EMAIL_PROVIDER` | Required explicit choice: `cloudflare` or `resend`. No default or automatic failover. |
| `QUOTUM_EMAIL_FROM` | Quotum's sender email address, from a domain verified with the selected provider. |
| `QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID`, `QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN` | Required only for Cloudflare Email Service. |
| `QUOTUM_EMAIL_RESEND_API_KEY` | Required only for Resend. Use a key permitted to send from the configured domain. |
| `MERCHANT_SIGNUP_ENABLED` | Defaults to `true`; set `false` to close registration. |
| `MERCHANT_GOOGLE_CLIENT_ID`, `MERCHANT_GOOGLE_CLIENT_SECRET` | Optional Google sign-in. Register `https://<merchant-origin>/api/auth/callback/google`. |

While the merchant platform runs, merchant authentication is always on: there is no switch to
serve `/api` without it, and the process refuses to start until the settings above validate, even
with signup disabled. Only `BILLING_ENV=test` permits absent email configuration, and runtime wiring
still requires an injected capture mailer. Explicit partial configuration is rejected in tests too.
SMTP is not an available configuration selector. Close signup explicitly until the deployment is
ready.

### Headless mode

`QUOTUM_MERCHANT_ENABLED=false` runs Quotum without the merchant platform. It is for operators who run
Quotum for their own products and have no merchant web application: the process serves the `/v1`
API, the provider webhooks and every worker, and nothing else.

- `/api/*`, merchant sign-in, onboarding, teams, step-up confirmation and merchant email do not
  exist; those paths answer like any other unknown path. Remote MCP needs merchant sign-in, so
  `QUOTUM_MCP_ENABLED=true` is refused at startup. The stdio [MCP server](mcp.md) still works.
- `QUOTUM_AUTH_SECRET`, `MERCHANT_*` and `QUOTUM_EMAIL_*` become optional. When set they are ignored,
  except that the retired names in the next section are still refused.
- Everything else is unchanged: `POSTGRES_URI`, `BILLING_OPERATOR_API_KEY` in production, and the
  `QUOTUM_SECRETS_KEY_*` key, which still decrypts stored connections. Provider webhooks, the
  connection-version verification route and, when `STRIPE_APP_*` is configured, the Stripe App
  event ingress keep working.
- Connections are created and changed on the merchant platform's **Integrations** screens, so a
  headless process serves the connections already stored in its database and cannot change them.

The flag is read at startup and accepts only `true` or `false`; unset or blank means `true`. Switching
modes needs a restart and no migration.

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

## First start

A fresh deployment needs no customer bootstrap. Start the service, then let merchants onboard
through the merchant application and configure providers and projections under **Integrations**.
A [headless](#headless-mode) deployment has no merchant application; it creates its topology and
credentials with the bootstrap below.
Each environment is configured independently: save a draft, verify provider access or the signed
projection challenge, then commit. Production commits require a fresh step-up grant. Changes take
effect without restarts, and one customer's setup never affects global readiness.

The `platform:bootstrap` manifest used in the [quickstart](quickstart.md) remains available as an
operator fixture for development and internal environments; it is not a sign-up prerequisite. The
bootstrap is declarative, additive and idempotent:

- It creates the declared organizations, logical projects and project instances that do not exist
  yet, so a later run can add an environment, a project or an organization.
- Every row already in the database must be declared with the same name, project, environment and
  lifecycle status. Any other difference, including a row the manifest omits, is refused before
  anything is written.
- It never updates or deletes a row. It never adds rows or credentials to an organization that has
  members (one onboarded through the merchant application) or is not active, and it does not apply
  the organization's production limit, which only gates merchant activation.
- It issues each declared credential once, into the `--credentials-out` file, so every run that
  issues one needs a new path.

`--check` prints the plan (`organizationsToCreate`, `logicalProjectsToCreate`,
`projectInstancesToCreate`, `credentialsToIssue`, `readOnlyCredentialsToIssue`) and exits `2` while
`--apply` has work to do, `0` once everything declared exists, and `1` when it refuses.

## Merchant proxy service principal

Browsers never receive billing credentials. A separate merchant proxy forwards allowlisted
`/api/auth`, `/api/platform`, and scoped `/api/billing` operations with a database-backed service
principal. Create it once after migrations:

```sh
quotum merchant service-principal <worker-name>
```

Configure merchant authentication before running the command. The token is printed exactly once;
store it as the proxy's `MERCHANT_SERVICE_TOKEN`, alongside its `MERCHANT_API_URL`. It is never a
browser credential. The command refuses an existing name. This principal is required for app
requests, not for global `/ready` to report database/schema health.

## Optional variables

### Remote MCP

Remote MCP is disabled by default. Set `QUOTUM_MCP_ENABLED=true` and
`QUOTUM_MCP_PUBLIC_ORIGIN=https://api.example.com` to enable browser authorization and `/mcp`.
Use an exact HTTPS API origin; keep `MERCHANT_ORIGIN` on the merchant UI origin. The origins may
be different. The API validates Host and any Origin header against configured origins.

The public API ingress must expose `/mcp`, `/oauth/token`, `/oauth/revoke`, `/oauth/jwks`,
`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp` without adding the merchant service token or cookies.
The UI Worker owns `/oauth/authorize`, sign-in, environment selection and consent; it forwards
only the exact browser `/api/auth/oauth2/authorize`, `/continue`, `/consent` and platform MCP routes
in its allowlist. Keep arbitrary `/api/auth/*` routes inaccessible through the Worker.

Upgrade order: prepare the matching baseline schema (see the
[schema policy](operations.md#schema-and-upgrade-policy)), deploy the API with MCP disabled, deploy
the matching UI/BFF contract and routes, then set the two MCP variables. `004_merchant.sql` adds
OAuth provider tables, signing keys, immutable grants, public coding-client registrations, and
proof binding. Existing populated deployments need a reviewed data-preserving transition; a
checksum mismatch must not be bypassed or handled by resetting production data. Disable the flag
to stop the remote ingress and browser authorization if rolling the UI back. The stdio server
retains its existing independent configuration.

See [MCP server](mcp.md#connect-in-a-browser) for identity, scope, lifetimes and revocation behavior.

### Stripe Apps OAuth

Optional and part of the merchant platform: merchants can install a Stripe App that the operator
publishes, based on [`stripe-app/stripe-app.example.json`](../stripe-app/stripe-app.example.json),
instead of entering a restricted key. `STRIPE_APP_CLIENT_ID` enables it and requires the rest.

| Variable | Purpose |
| --- | --- |
| `STRIPE_APP_CLIENT_ID` | The app's OAuth client id. Unset or empty disables Stripe Apps OAuth. |
| `STRIPE_APP_REDIRECT_URI` | The HTTPS OAuth callback registered with the app, served by the merchant application. |
| `STRIPE_APP_TEST_AUTHORIZE_URL`, `STRIPE_APP_LIVE_AUTHORIZE_URL` | The app's install links from the Stripe Dashboard, under `https://marketplace.stripe.com/oauth/v2/authorize`. |
| `STRIPE_APP_TEST_API_KEY`, `STRIPE_APP_LIVE_API_KEY` | The app owner's `sk_test_` and `sk_live_` secret keys, which exchange and refresh OAuth tokens. |
| `STRIPE_APP_TEST_WEBHOOK_SECRET`, `STRIPE_APP_LIVE_WEBHOOK_SECRET` | Signing secrets for app events delivered to `/v1/stripe-app/webhooks/test` and `/v1/stripe-app/webhooks/live`. |

The client id and redirect URI are checked at startup; each mode's key, secret and install link are
checked when that mode is first used. Installing the app happens in the merchant application. With
the settings present, a [headless](#headless-mode) process still refreshes existing OAuth
connections and processes app events, including deauthorization.

### Other optional variables

Defaults in parentheses.

- `BILLING_AUTH_MODE=api_key|gateway` (`api_key`). Use `gateway` only when a trusted gateway
  enforces access to non-webhook `/v1/*` routes and sends `x-billing-project-key`; it also requires
  `BILLING_TRUST_GATEWAY_PROJECT_HEADER=true`.
- `BILLING_PROJECTION_ALLOWED_NETWORKS` (unset). Headless only: comma-separated private networks or
  addresses, such as `10.20.0.0/16,fd00::/8`, that projection receivers may resolve to besides
  public addresses. See [private receivers](providers.md#private-receivers-headless-only) for the
  allowed ranges and the risks. Starting with it while the merchant platform is on is an error.
- `BILLING_PROJECTION_ALLOW_INSECURE_HTTP=true|false` (`false`). Headless only: also accept
  `http://` receiver URLs when every resolved address is in an approved network. Requires
  `BILLING_PROJECTION_ALLOWED_NETWORKS`. The projection secret then crosses that network in
  cleartext.
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
  `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS` (`5000`), which also paces Stripe App event
  processing when Apps OAuth is configured.
- `BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS` (`10`),
  `BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS` (`60000`),
  `BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS` (`21600000`).
- `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` (`60000`), shared by metering maintenance,
  recurring billing, automatic top-ups and promotion maintenance.
- `BILLING_USAGE_PARTITION_UPKEEP=true|false` (`true`). Keeps monthly usage partitions a year
  ahead; see [usage partitions](operations.md#usage-partitions). Set `false` only when a role that
  owns `usage_events` creates them instead.
- `BILLING_RATE_LIMIT_WINDOW_MS` (`60000`), `BILLING_VERIFY_RATE_LIMIT_PER_WINDOW` (`120`),
  `BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW` (`600`), `BILLING_METERING_RATE_LIMIT_PER_WINDOW`
  (`6000`), `BILLING_ADMIN_RATE_LIMIT_PER_WINDOW` (`60`).
- `BILLING_LOG_LEVEL` (`info`): `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`.
  Controls local Pino diagnostics independently of Sentry; invalid or blank values are rejected.
- Sentry error reporting is optional; see [Sentry (optional)](#sentry-optional).

Removed and rejected when supplied: `BILLING_PROJECT_RUNTIME_JSON`, `BILLING_PROJECTS_JSON`, and
`BILLING_PROJECTION_ADAPTER`. Provider and projection settings live in encrypted, versioned
connections owned by the merchant platform.

### Sentry (optional)

Leave `SENTRY_DSN` unset or blank to disable Sentry; without a DSN the SDK is never initialized.
With a DSN, the service reports staff and merchant 5xx responses and worker failures.

- `SENTRY_DSN` (unset).
- `SENTRY_ENVIRONMENT` (`BILLING_ENV`): at most 64 characters, without whitespace or `/`.
- `SENTRY_RELEASE` (`quotum-api@$BUILD_VERSION` when the image sets `BUILD_VERSION`, else unset).
- `SENTRY_ENABLE_LOGS` (`true`), `SENTRY_LOG_LEVEL` (`warn`),
  `SENTRY_TRACES_SAMPLE_RATE` (`0.01`; `0` disables tracing),
  `SENTRY_CAPTURE_EXPECTED_ERRORS` (`false`).

Sent: scrubbed error messages and stack frames, route patterns, method, status, error codes,
project key, provider, worker names, hostname, runtime, OS and module versions, and sampled
transactions.

Never collected: request and response headers, cookies, query strings and fragments, bodies,
client IP addresses, user data, local variables, SQL query parameters, and console
breadcrumbs.

Masked on a best-effort basis: free text such as messages and log attributes is scrubbed with
patterns. Bearer and Basic credentials, JWTs, project API keys, Stripe-style ids and keys, emails,
IPv4 addresses, runs of 14 or more digits and opaque tokens of 32 or more characters are
replaced. Keys named like secrets, tokens, sessions, emails or customer ids are dropped. Path
identifiers become `:id`. An identifier that looks like an ordinary word inside a message is not
recognized, so avoid putting customer data into error messages. Local Pino log lines are never
scrubbed.

## Encryption-key rotation

Deploy a new active key while retaining the old key in the paired
`QUOTUM_SECRETS_PREVIOUS_KEY_ID`/`QUOTUM_SECRETS_PREVIOUS_KEY_BASE64` settings. Run
`quotum connections rotate-secrets` against the target database and verify every envelope now uses
the active key before retiring the previous runtime key. Keep keys needed by retained backups in
recovery secret storage. Rotation is restartable; missing or wrong keys fail closed.

## Authentication

In `api_key` mode, trusted backends send a database-issued project credential as
`Authorization: Bearer <credential>`. Credentials are 48 characters: a prefix followed by 43
base64url characters of random secret. `sqpk_` (sandbox) and `pqpk_` (production) are full keys;
`sqrk_` and `pqrk_` are [read-only keys](api.md#read-only-credentials). The database stores only the
SHA-256 hash of the whole token under a unique index together with the credential's access level.
Authentication looks the hash up and requires the prefix to match both the instance's environment
and the stored access level; the stored level, not the prefix, decides what the key may do. Internal
instances never receive credentials. Every rejected credential returns the same `401 UNAUTHORIZED`
error. See
[replacing project credentials](operations.md#project-credentials) for rotation and the retired
`qpk_v1` format. Operator routes additionally require `X-Billing-Operator-Key`,
and audited mutations require `X-Billing-Actor`. Provider webhooks are outside project
authentication and rely on provider signature or token verification.

In `gateway` mode, billing-level key checks are disabled for non-webhook `/v1/*` routes only when
`BILLING_TRUST_GATEWAY_PROJECT_HEADER=true`; the gateway must enforce access and send
`x-billing-project-key`. No credential is read in this mode, so the gateway states the access it
granted: `x-billing-credential-access: read_only` restricts the request to the
[read-only operations](api.md#read-only-credentials) exactly like a read-only key, while `full` or
no header means full access. Any other value is `400 INVALID_REQUEST`, never read as full. Like the
project header, it is trusted only from the gateway, which must strip any copy a client sends. In
`api_key` mode the header is ignored and the stored credential decides.

## Test entrypoints

`bun run test:stripe-entrypoint` starts the service with an in-memory connection fixture and a
network-free fake Stripe client. It requires `BILLING_ENV=test`, `BILLING_TEST_FAKE_STRIPE=true`,
and either `QUOTUM_AUTH_SECRET` with the two legal versions or `QUOTUM_MERCHANT_ENABLED=false`; it
refuses external provider traffic and keeps merchant mail in memory instead of sending it. It accepts
`BILLING_TEST_FAKE_STRIPE_PAYMENT_BEHAVIOR=succeeded|action_required|retryable_failure`,
`BILLING_TEST_FAKE_STRIPE_DEFAULT_PAYMENT_METHOD=missing`, and
`BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON` for deterministic worker scenarios. Never set
`BILLING_TEST_*` or `MERCHANT_TEST_MODE` in a deployed service.
