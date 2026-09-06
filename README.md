# Voysee Billing

API-only billing service for Voysee and other product apps. Billing owns the billing database and
service state: customers, products, purchases, subscriptions, entitlements, provider events, and
projection jobs live in billing-managed tables. Product apps do not share billing tables with this
service, and billing does not share or write product app tables. Product backends call billing APIs
for authoritative state and receive HTTP projection callbacks to maintain their own app-local read
models.

Detailed API documentation is maintained in [../quotum-docs/api](../quotum-docs/api/), with the
shared catalog at [../quotum-docs](../quotum-docs/).

## Current Status

Implemented:

- Postgres migrations with billing-owned customers, purchases, subscriptions, immutable catalog
  revisions/plan versions, provider mappings, allocations, entities, usage windows, partitioned
  usage events, rollups, reservations, idempotency lanes, and projection jobs.
- Operator-protected catalog preview/publish workflow with exact-intent tokens, stale-revision
  checks, provider capability validation, durable adopted-provider operations, active pointers, and
  audit records.
- Customer-relative Stripe commercial previews for plan Checkout, one-time purchases, and
  subscription changes. Execution is bound to an expiring preview token, current catalog/customer
  fingerprint, and one durable idempotency key.
- Bounded usage-event pagination, hour/day usage series, and a provider-neutral customer billing
  summary for trusted backend billing pages and support tooling.
- A typed backend-only `BillingClient`, `defineCatalog` helper, and catalog-as-code CLI for published
  catalog status, diff/preview, and token-bound publication.
- Authoritative fixed-decimal metering with check/consume/reserve/confirm/release/correction APIs,
  capped meter windows, wallet conversion rate cards, deterministic allocation receipts, and
  provider-neutral balance reads.
- Apple, Google, and Stripe subscription/top-up allocation materialization, including proportional
  partial refund constraints and exact-once full reversals.
- Time-partitioned raw usage, durable monthly rollups, reservation expiry, period close, catalog
  draft/idempotency retention maintenance, metering rate limits, and latency histograms.
- Recurring pricing with fixed recurring fees, included allowances, explicit licensed quantities,
  hybrid base-plus-metered plans, Stripe trials/add-ons, durable plan changes and proration rules,
  exact postpaid overage invoices, and referenced late-correction credits.
- Phase 3 controls and enterprise pricing with exact graduated/volume tiers, capped rollover
  allocations and detailed balances, durable spend/usage controls and alert crossings, bounded
  off-session Stripe top-ups with cooldown/circuit state, scheduled versioned contracts,
  customer-specific plans, grandfathered catalog migrations, and assignable entity license pools.
- TypeScript/Drizzle entitlement recomputation and expiry-aware entitlement snapshots.
- Atomic purchase recording transactions that also enqueue projection sync work.
- Projection sync worker with retry/backoff support.
- API-key protected entitlement snapshot endpoint:
  `GET /v1/billing-accounts/:billingAccountId/entitlements`.
- Apple StoreKit 2 purchase verification:
  `POST /v1/purchases/verify` with `provider="apple"`.
- API-key protected Apple app account token endpoint:
  `GET /v1/billing-accounts/:billingAccountId/providers/apple/account-token`.
- Public App Store Server Notifications V2 webhook endpoint:
  `POST /v1/projects/:projectKey/webhooks/apple`.
- Google Play Billing purchase verification:
  `POST /v1/purchases/verify` with `provider="google"`.
- API-key protected Google Play account-link endpoint:
  `GET /v1/billing-accounts/:billingAccountId/providers/google/account-link`.
- Public Google Play Real-time Developer Notifications webhook endpoint:
  `POST /v1/projects/:projectKey/webhooks/google`.
- Stripe Checkout and Customer Portal for web subscriptions and consumable credit packs:
  `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions` and
  `POST /v1/billing-accounts/:billingAccountId/providers/stripe/portal-sessions`.
- API-key protected Stripe web catalog and billing-account views:
  `GET /v1/catalog?provider=stripe&channel=web` and
  `GET /v1/billing-accounts/:billingAccountId/billing-account`.
- Idempotent Stripe plan/seat changes:
  `POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes`.
- Public Stripe webhook endpoint for web subscription and consumable credit-pack state:
  `POST /v1/projects/:projectKey/webhooks/stripe`.
- HTTP `billing_state_v1` projection delivery of entitlement and exact-string balance snapshots from
  billing workers to product backend APIs.
- Backend-only dashboard/admin API for customer drilldown, support search, global ops lists,
  read-only catalog context, and store-event detail inspection.
- Configurable service auth with `BILLING_AUTH_MODE=api_key|gateway`.
- Database-authoritative organizations, logical projects, project instances, and one-way-hashed
  project credentials, with an exact-manifest bootstrap command and no runtime JSON auth fallback.
- Event replay and subscription reconciliation workers with protected admin operations.
- Prometheus metrics endpoint and per-route-family rate limits.

For mobile digital goods, the native providers are Apple In-App Purchase / StoreKit and Google Play
Billing. Apple Pay and Google Pay wallet buttons are web/payment-wallet flows, usually exposed here
through Stripe rather than through the native mobile in-app purchase paths.

## Setup

Install dependencies:

```sh
bun install
```

Apply the billing database migrations to the target Postgres database:

```sh
POSTGRES_URI="postgres://postgres:postgres@127.0.0.1:5432/voysee_billing" bun run migrate
```

Before 1.0 the schema files under `migrations/` evolve in place; recreate development databases
instead of migrating them. After it is applied, create the initial platform topology and
credentials from an explicit manifest:

```sh
export POSTGRES_URI="postgres://postgres:postgres@127.0.0.1:5432/voysee_billing"
export BILLING_PLATFORM_BOOTSTRAP_JSON='{
  "version": 1,
  "organizations": [{
    "slug": "voysee",
    "name": "Voysee",
    "projects": [{
      "key": "voysee",
      "name": "Voysee",
      "instances": [{
        "key": "voysee-production",
        "environment": "production",
        "lifecycleStatus": "active",
        "issueCredential": true
      }]
    }]
  }]
}'
umask 077
bun run platform:bootstrap -- --apply --credentials-out ./platform-credentials.json
bun run platform:bootstrap -- --check
```

The bootstrap is empty-or-exact and idempotent: it refuses undeclared rows or topology drift.
`--check` exits nonzero until both the topology and every declared credential are present. The
credentials file is created exclusively with mode `0600`, fsynced, never printed to stdout, and
contains the only copy of each new plaintext token. Move those tokens into the calling backend's
secret store, then remove the local file. A lost token cannot be read back; revoke it and issue a
new credential through an approved operational procedure.

Database requirements:

- Configure `POSTGRES_URI` with a direct Postgres connection string. Neon-compatible Postgres is
  supported.
- SQL files in `migrations/` are the deployment source of truth. The Drizzle schema mirrors the
  current table shape for typed application access.
- `bun run migrate` takes a Postgres advisory lock before applying pending migrations. Migrations
  run transactionally by default; include `-- migrate: no-transaction` or use
  `CREATE INDEX CONCURRENTLY` when a migration must run outside a transaction.
- Run `POSTGRES_URI=... bun run migrate:status` to inspect applied migration checksums.
- Seed `products` and `store_products` before real provider verification is enabled.
  For Apple, `store_products.provider` must be `apple`, `channel` must be `ios`, and
  `external_product_id` must match the App Store Connect product id.
  For Google, `provider` must be `google`, `channel` must be `android`, `external_product_id`
  must match the Play subscription or one-time product id, and `external_price_id` should hold the
  base plan id when base plans map to different internal products or prices.
  For Stripe web billing, `provider` must be `stripe`, `channel` must be `web`,
  `external_product_id` must match the Stripe product id, and `external_price_id` must match the
  Stripe price id. Stripe consumable credit-pack rows must also set `currency` and `price_amount`
  to the Stripe Price currency and amount in minor units.
- Publish the versioned feature/plan/top-up/rate-card intent through the catalog preview and publish
  endpoints. Runtime provider purchases fund allocations only through published provider bindings.

## Configuration

Required:

- `POSTGRES_URI`
- `BILLING_PROJECT_RUNTIME_JSON`
  Defines only runtime delivery and provider adapters for every database project instance. Its
  `projectInstanceKey` values must exactly match the `projects` rows or `/ready` returns `503`.
  Identity, lifecycle, environment, credentials, and catalog declarations are deliberately not
  accepted here. Projection delivery is an HTTP `POST` to
  `<projectionUrl>/internal/billing/projections`; production URLs must be public HTTPS URLs.

  ```json
  [
    {
      "projectInstanceKey": "voysee-production",
      "projectionUrl": "https://voysee.example.com",
      "projectionSecret": "voysee-projection-secret",
      "projectionContract": "billing_state_v1",
      "apple": {
        "bundleId": "com.voysee.app",
        "appAppleId": 1234567890,
        "issuerId": "app-store-connect-issuer-id",
        "keyId": "in-app-purchase-key-id",
        "privateKey": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----",
        "environment": "production",
        "enableOnlineChecks": true,
        "rootCertificatesDir": null
      },
      "googlePlay": {
        "packageName": "com.voysee.app",
        "serviceAccountJson": "{\"type\":\"service_account\"}",
        "serviceAccountKeyFile": null,
        "obfuscatedAccountIdSecret": "account-link-secret",
        "previousObfuscatedAccountIdSecrets": [],
        "rtdnAudience": "https://billing.example.com/v1/projects/voysee-production/webhooks/google",
        "rtdnServiceAccountEmail": "pubsub-push@example.iam.gserviceaccount.com",
        "rtdnAuthorizedParty": "pubsub-push-client-id",
        "enablePublisherMutations": true
      },
      "stripe": {
        "secretKey": "sk_live_...",
        "webhookSecret": "whsec_...",
        "checkoutSuccessUrl": "https://voysee.example.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
        "checkoutCancelUrl": "https://voysee.example.com/billing",
        "portalReturnUrl": "https://voysee.example.com/account/billing",
        "allowedReturnOrigins": ["https://voysee.example.com"],
        "taxMode": "registered",
        "integrationIdentifier": "qfmxzjpa"
      }
    }
  ]
  ```

  Provider configuration is strictly project-scoped. Omitting `apple`, `googlePlay`, or `stripe`
  (or setting it to `null`) disables that provider for the project.
  `projectionContract` accepts only `billing_state_v1` and defaults to it. The schema is strict:
  legacy `key`, `apiKey`, `active`, and `catalog` fields fail startup instead of being ignored.
  Project credentials use the versioned `qpk_v1.<credential-id>.<secret>` format; only their
  SHA-256 verifiers are stored in `platform_project_api_credentials`. Revocation, expiration, and
  project lifecycle changes take effect on the next request, and a database outage fails auth
  closed with `503`—there is no JSON fallback.

Catalog import is a separate, explicit development command for already-bootstrapped instances:

```sh
POSTGRES_URI=... \
BILLING_CATALOG_IMPORT_JSON='[{"projectInstanceKey":"voysee-production","catalog":[...]}]' \
bun run catalog:provision
```

After a versioned catalog revision is published, the import leaves that project's catalog
untouched. Production catalog changes should use the preview/publish contract.

Required in production:

- `BILLING_OPERATOR_API_KEY`
  Separate operator key required for store-event replay, subscription reconciliation, projection
  retry, and process-wide metrics. Keep this distinct from per-project API keys and send it as
  `X-Billing-Operator-Key` only from trusted operational tooling.

Optional:

- `BILLING_ENV=development|test|production`
  Defaults to `production`. Production additionally enforces public HTTPS projection URLs and an
  operator API key, and rejects non-HTTPS Stripe redirect URLs and allowed origins.
- `BILLING_AUTH_MODE=api_key|gateway`
  Defaults to `api_key`. Use `gateway` only when the billing service is private behind a gateway or
  trusted upstream backend that enforces access to non-webhook `/v1/*` routes and sends
  `x-billing-project-key`.
- `BILLING_TRUST_GATEWAY_PROJECT_HEADER=true|false`
  Defaults to `false`. Must be set to `true` when `BILLING_AUTH_MODE=gateway`; this is an explicit
  deployment assertion that only the trusted gateway or upstream backend can set
  `x-billing-project-key`.

`BILLING_PROJECTION_ADAPTER` has been removed and is rejected in every environment; billing never
writes product app databases directly. Product backends receive projection callbacks and update
their own read models idempotently.

- `BILLING_WORKER_ID`
  Defaults to a generated worker id.
- `BILLING_WORKER_POLL_INTERVAL_MS`
  Defaults to `5000`.
- `BILLING_PROJECTION_SYNC_MAX_ATTEMPTS`
  Defaults to `10`.
- `BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS`
  Defaults to `10`.
- `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS`
  Defaults to `5000`.
- `BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS`
  Defaults to `10`.
- `BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS`
  Defaults to `60000`.
- `BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS`
  Defaults to `21600000`.
- `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS`
  Defaults to `60000`.
- `BILLING_RATE_LIMIT_WINDOW_MS`
  Defaults to `60000`.
- `BILLING_VERIFY_RATE_LIMIT_PER_WINDOW`
  Defaults to `120`.
- `BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW`
  Defaults to `600`.
- `BILLING_ADMIN_RATE_LIMIT_PER_WINDOW`
- `BILLING_METERING_RATE_LIMIT_PER_WINDOW`
  Defaults to `6000`.
- `BILLING_TRUST_PROXY_HEADERS=true|false`
  Defaults to `false`. When `false`, rate-limit keys ignore `cf-connecting-ip` and
  `x-forwarded-for`; enable only when the service is behind trusted infrastructure that strips
  untrusted client-supplied proxy headers.
- `SENTRY_DSN`
  Defaults to unset, so Sentry is disabled unless a DSN is configured. Set to an empty string to
  disable Sentry explicitly.
- `SENTRY_ENABLE_LOGS=true|false`
  Defaults to `true` and enables Sentry structured logs.
- `SENTRY_TRACES_SAMPLE_RATE`
  Defaults to `0.01`, capturing 1% of transactions.
- `SENTRY_LOG_LEVEL=info|warn|error`
  Defaults to `warn`. Routine info logs stay on stdout; selected worker/purchase/webhook summaries
  are still allowed through Sentry for issue correlation.
- `SENTRY_CAPTURE_EXPECTED_ERRORS=true|false`
  Defaults to `false`, so expected 4xx `BillingError` responses are logged and breadcrumbed but not
  captured as Sentry issues.

Apple StoreKit:

- `apple.bundleId`
  App bundle id, for example `com.voysee.app`.
- `apple.issuerId`
  App Store Connect issuer id for the In-App Purchase key.
- `apple.keyId`
  App Store Connect In-App Purchase key id.
- `apple.privateKey`
  Private key contents from the App Store Connect `.p8` file.
- `apple.environment`
  Must be `sandbox` or `production`. Production retries sandbox verification only for signed
  payloads that Apple's verifier rejects with an explicit environment mismatch.
- `apple.appAppleId`
  Numeric App Store app id; required in production and otherwise may be `null`.
- `apple.enableOnlineChecks`
  Boolean controlling Apple signed-data online checks; it must be `true` in production.
- `apple.rootCertificatesDir`
  Optional override for Apple root certificates. By default the service loads committed public
  Apple PKI roots from `src/providers/apple/certs/`; set it to `null` for the default.

Apple StoreKit client flow:

1. Trusted app backend calls
   `GET /v1/billing-accounts/:billingAccountId/providers/apple/account-token`.
2. Backend returns the UUID token to the iOS app.
3. iOS app passes the UUID as StoreKit 2 `appAccountToken` when purchasing.
4. iOS app sends the completed StoreKit transaction id to the trusted backend.
5. Backend calls `POST /v1/purchases/verify` with `provider="apple"`, `billingAccountId`, and
   `transactionId`.
6. Billing verifies the transaction with Apple, requires the transaction `appAccountToken` to match
   the customer token, records billing state, enqueues projection sync, and returns the entitlement
   snapshot.

Configure App Store Server Notifications V2 in App Store Connect with the HTTPS URL:

```text
https://<billing-host>/v1/projects/<projectKey>/webhooks/apple
```

Billing explicitly classifies App Store Server Notification V2 types and subtypes. Notifications
that do not change local entitlements, such as `TEST`, `REFUND_DECLINED`,
`CONSUMPTION_REQUEST`, renewal-extension summaries, external purchase token events, and Advanced
Commerce metadata events, are acknowledged without durable billing writes.

Apple sends this webhook directly, so it is intentionally outside project API-key middleware.

Google Play Billing:

- `googlePlay.packageName`
  Android package name, for example `com.voysee.app`.
- `googlePlay.serviceAccountJson`
  Raw service account JSON with Android Publisher API access.
- `googlePlay.serviceAccountKeyFile`
  Alternative to `serviceAccountJson`; path to the service account JSON file.
- `googlePlay.obfuscatedAccountIdSecret`
  Secret used to derive non-PII Play Billing `obfuscatedAccountId` values.
- `googlePlay.previousObfuscatedAccountIdSecrets`
  Array of previous secrets accepted for already-linked purchases during account-id secret
  rotation. New account-link responses always use `obfuscatedAccountIdSecret`.
- `googlePlay.rtdnAudience`
  Audience configured on the authenticated Pub/Sub push subscription.
- `googlePlay.rtdnServiceAccountEmail`
  Service account email configured for Pub/Sub push authentication.
- `googlePlay.rtdnAuthorizedParty`
  Authorized party/client id expected in the Pub/Sub push OIDC token `azp` claim.
- `googlePlay.enablePublisherMutations`
  Boolean controlling whether the service acknowledges subscriptions and non-consumables and
  consumes consumables after billing state is durably recorded.

Exactly one of `serviceAccountJson` or `serviceAccountKeyFile` is required when Google Play Billing
is configured. RTDN auth config must include audience, push service-account email, and authorized
party together. Configure the Play Console RTDN Pub/Sub push subscription with the HTTPS URL:

```text
https://<billing-host>/v1/projects/<projectKey>/webhooks/google
```

Google sends this webhook directly through Pub/Sub, so it is intentionally outside project API-key
middleware; instead the service verifies the Pub/Sub push OIDC token issuer, audience, authorized
party, service-account email, and expiry. Google RTDN numeric notification types are stored as named
event types such as `SUBSCRIPTION_PURCHASED` and `ONE_TIME_PRODUCT_PURCHASED`.
Voided purchase RTDNs use a stable `google:voided:<purchaseToken>:<eventTimeMillis>:...` external
event id and resolve local targets by purchase token only.

Google Play client flow:

1. Trusted app backend calls
   `GET /v1/billing-accounts/:billingAccountId/providers/google/account-link`.
2. Backend returns `obfuscatedAccountId` to the Android app.
3. Android app passes that value into the Play Billing flow with `setObfuscatedAccountId`.
4. Android app sends purchase token, purchase kind, and product id for one-time products to the
   trusted backend.
5. Backend calls `POST /v1/purchases/verify` with `provider="google"`.
6. Billing verifies the purchase token with Google, records billing state, acknowledges or consumes
   when required, enqueues projection sync, and returns the entitlement snapshot.

Stripe Web Billing:

- `stripe.secretKey`
  Stripe secret API key used to create Customers, Checkout Sessions, Billing Portal Sessions, and
  retrieve Checkout or subscription state.
- `stripe.webhookSecret`
  Signing secret for the Stripe webhook endpoint.
- `stripe.checkoutSuccessUrl`
  Hosted app success URL. This must include the literal `{CHECKOUT_SESSION_ID}` placeholder so
  Stripe can redirect with the created Checkout Session id.
- `stripe.checkoutCancelUrl`
  Hosted app URL where Stripe redirects users who cancel Checkout.
- `stripe.portalReturnUrl`
  Hosted app URL where Stripe redirects users when leaving the Customer Portal.
- `stripe.allowedReturnOrigins`
  Exact origins accepted for request-level `successUrl`, `cancelUrl`, and `returnUrl` overrides.
  Defaults to the origins of the configured fallback URLs.
- `stripe.taxMode`
  `disabled` omits Stripe Tax fields, `test` enables automatic tax only with a Stripe test key,
  and `registered` enables automatic tax for an account whose registrations are managed in Stripe.
- `stripe.integrationIdentifier`
  Stripe integration identifier sent on hosted Checkout Sessions. Defaults to `qfmxzjpa`.

Configure the Stripe webhook endpoint in Stripe with the HTTPS URL:

```text
https://<billing-host>/v1/projects/<projectKey>/webhooks/stripe
```

Stripe sends this webhook directly, so it is intentionally outside project API-key middleware;
instead the service verifies the `stripe-signature` header with the project's `webhookSecret`.

Stripe web Checkout flow:

1. Trusted app backend reads `GET /v1/catalog?provider=stripe&channel=web`, then calls
   `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions`. The request
   accepts exactly one legacy `productKey` or `planKey`; a plan also supplies a
   `quantities` object containing every licensed item. Optional `email`, `successUrl`, and
   `cancelUrl` are supported, and callers should send `Idempotency-Key` for a durable receipt.
2. Billing validates the internal target and explicit quantity bounds, creates or reuses a Stripe
   Customer, and returns a
   hosted Checkout result `{sessionId,url,duplicate}`. A completed receipt replay returns
   `duplicate: true` without creating another Session.
3. Frontend redirects the user to Stripe.
4. Stripe sends webhooks to `POST /v1/projects/:projectKey/webhooks/stripe`.
5. Billing records paid subscription or credit-pack state and enqueues projection sync.
6. Success pages may poll
   `GET /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId`; that endpoint is
   read-only and never grants access.

Base and licensed prices are Checkout subscription line items. Metered overage remains in billing's
authoritative usage ledger and is invoiced by the recurring billing worker after the retained period
closes. Add-ons use a separate subscription and require an active base plan. Subscription changes
are queued through
`POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes`; upgrades and
quantity changes default to immediate application, while downgrades default to period end.

Stripe credit-pack refunds and disputes reverse credits proportionally to the cumulative reversed
payment amount. Billing deduplicates `refund.created` and `refund.updated` by Stripe refund id so
the same refund cannot be applied twice. Amounts above the original payment or currency mismatches
are recorded as skipped replayable events and do not emit reversal projections. Configure Stripe
to send `refund.created` and `refund.updated` for refunds; `charge.refunded` carries cumulative
Charge state and is safely ignored if delivered.

Trusted app backends can also create Customer Portal Sessions with
`POST /v1/billing-accounts/:billingAccountId/providers/stripe/portal-sessions`; it returns `{url}`. Checkout
polling returns `{sessionId,status,paymentStatus,customerEmail,productKey}`. Email and
product key are present only after the Session is paid.

Legacy unscoped `/v1/webhooks/*` aliases have been removed. Provider endpoints must use the
canonical project-instance route `/v1/projects/:projectKey/webhooks/:provider`.

## Metering and Catalog

Trusted product backends authorize metered work through billing:

```http
GET  /v1/billing-accounts/:billingAccountId/balances/:featureKey
GET  /v1/billing-accounts/:billingAccountId/billing-summary
GET  /v1/billing-accounts/:billingAccountId/usage/events
GET  /v1/billing-accounts/:billingAccountId/usage/series
POST /v1/billing-accounts/:billingAccountId/usage/check
POST /v1/billing-accounts/:billingAccountId/usage/consume
POST /v1/billing-accounts/:billingAccountId/usage/reservations
POST /v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/confirm
POST /v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/release
POST /v1/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections
POST /v1/billing-accounts/:billingAccountId/entities
GET  /v1/billing-accounts/:billingAccountId/entities
PUT  /v1/billing-accounts/:billingAccountId/controls
GET  /v1/billing-accounts/:billingAccountId/controls
POST /v1/billing-accounts/:billingAccountId/usage-alerts
GET  /v1/billing-accounts/:billingAccountId/usage-alerts
GET  /v1/billing-accounts/:billingAccountId/usage-alert-events
PUT  /v1/billing-accounts/:billingAccountId/auto-topup
GET  /v1/billing-accounts/:billingAccountId/auto-topup?featureKey=:featureKey[&entityId=:entityId]
GET  /v1/billing-accounts/:billingAccountId/license-pools
POST /v1/billing-accounts/:billingAccountId/license-assignments
DELETE /v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId
GET  /v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey
POST /v1/billing-accounts/:billingAccountId/commercial-actions/preview
POST /v1/billing-accounts/:billingAccountId/commercial-actions
```

Usage mutations require `Idempotency-Key`; corrections also require `X-Billing-Actor`. Control,
alert, automatic-top-up, and license-assignment mutations require `X-Billing-Actor`, while entity
creation does not. Quantities are decimal strings. A check is side-effect-free, consume records an
immutable receipt, and reservation finalization is atomic. Product projections are display caches
and cannot replace these calls.

Commercial preview accepts one complete Stripe intent: `checkout_plan`, `checkout_product`, or
`subscription_change`. The response identifies exact or provider-calculated amounts and expires
after 15 minutes. Execution accepts only its `previewToken`, requires `Idempotency-Key`, and rejects
expired previews, catalog/customer drift, changed execution identity, or a mismatched target. A
Checkout result is synchronous HTTP 200; a durable subscription-change result is accepted with
HTTP 202.

Usage-event reads default to the last 30 days, reject ranges over 90 days, and use an opaque cursor
with a default page size of 50 and maximum of 200. Usage series support `hour` or `day` buckets over
the same bounded window. These routes and `billing-summary` are read models only; they never
authorize work.

Catalog operators submit the same complete intent to `POST /v1/admin/catalog/preview` and
`POST /v1/admin/catalog/publish`. Publish also supplies the preview token and expected revision;
both routes require project auth, operator auth, and `X-Billing-Actor`. Provider bindings adopt
pre-provisioned Apple, Google, or Stripe store-product rows and must all be ready before the active
catalog pointer advances. Previously active features, plans, and top-ups must be retained or named
in the corresponding explicit retirement list; omission is not deletion. Unchanged plans reuse
their immutable version, while retiring a plan removes it from new selection without rewriting
subscriptions already pinned to that version. See
[the service contract](../quotum-docs/api/billing-service-contract.md) for request and projection shapes.

Trusted tooling can read the active intent with `GET /v1/admin/catalog`. The backend SDK is exported
from `quotum-api/sdk`; it keeps project/operator credentials server-side and exposes typed
catalog, commercial, usage, and selected admin calls. The bundled catalog-as-code client uses the
same API contract:

```sh
BILLING_BASE_URL=https://billing.example.com \
BILLING_PROJECT_API_KEY=... \
BILLING_OPERATOR_API_KEY=... \
BILLING_ACTOR=deploy@example.com \
bun run catalog status

bun run catalog diff ./billing.catalog.ts
bun run catalog push ./billing.catalog.ts
```

## Usage Operation Recovery

API `0.7.0` adds recovery for the existing synchronous consume, reserve, confirm, release and
correction endpoints. Keep the same caller-owned `Idempotency-Key` after a timeout, lost response,
`5xx` or restart. Its scope is `(projectInstanceId, billingAccountId, operation kind, key)`.
Same-input replay returns the original domain result, including a denial, without reevaluating
today's balance or catalog. Different semantic input returns `409 IDEMPOTENCY_CONFLICT`.
Preserve semantic metadata and `occurredAt` across retries; put per-attempt tracing in transport
headers, which are not part of the operation fingerprint.

```http
GET /v1/billing-accounts/account_123/usage/operations/consume/job_789
Authorization: Bearer <database-issued project credential>
```

This project-authenticated, metering-rate-limited lookup uses the standard success envelope.
Its data contains `operation`, `operationId`, `status`, `completedAt` and `outcome`. Processing
operations have null completion/outcome; completed operations return a compact receipt with the
original decision, event/reservation references and balance totals, without allocation arrays or
rate-card tiers. URL-encode account and operation IDs independently. The backend SDK exposes
`client.usage.getOperation({ billingAccountId, operation, operationId })`; it does not yet automate
retry/recovery or generate replacement keys.

- `409 OPERATION_IN_PROGRESS`: another transaction owns the operation. Look up/retry the same
  identity and input within the caller's deadline; an in-progress response is not proof of commit.
- `409 OPERATION_RESULT_EXPIRED`: the identity is retained but its original result is unavailable.
  Do not mint another key to repeat the charge.
- `404 OPERATION_NOT_FOUND`: no retained identity exists. After an uncertain request, retry only
  the original input/key, never a new logical operation.

Accounting, projection intent, claim and terminal result commit in one transaction. A non-blocking
transaction-scoped advisory lock prevents concurrent duplicate execution. Proven rollback removes
all these effects; an unknown commit must be recovered from the authoritative database.

The `usage-recovery-v1` technical policy retains outcomes for at least 24 hours after completion and
identities/fingerprints for at least seven days, honoring longer configured client TTLs. Expired
results remain deduplication tombstones until identity expiry; unresolved claims are never swept.
Identity expiry ends the guarantee: callers must never reuse an old operation ID for new work.
Detailed mutation results are limited to 64 KiB of stored domain JSON; exceeding the bound returns
`500 OPERATION_OUTCOME_TOO_LARGE` and rolls back the complete mutation. Compact command responses,
broader reservation changes and Public Usage API/SDK GA remain separate increments.
Accounts with sufficiently large allocation breakdowns can repeatedly hit this bound; retries alone
will not resolve it. Stop retrying that operation and investigate the account's allocation/provenance
size. This increment does not commit a charge while discarding its required recoverable outcome.

**Upgrade from 0.6.0:** drain old API usage writers and metering-maintenance workers, recreate the
database from the baseline files, then start the new build. Do not mix old writers/sweepers with
this build. Legacy claims retain their identities
for at least seven additional days and return `OPERATION_RESULT_EXPIRED`, since their original
outcomes cannot safely be reconstructed. Rolling back to old binaries requires keeping usage
traffic stopped until a compatible build is restored.
An incomplete drain is unsupported: post-migration old-writer claims can remain unresolved, and
old sweepers can remove retained identities. Stop usage traffic and reconcile such a rollout before
resuming; do not delete unknown-outcome claims or create replacement keys to force progress.

## Admin Operations

Admin and service routes require trusted backend access. In `api_key` auth mode, callers use a
database-issued project credential from the trusted backend's secret store as
`Authorization: Bearer <project credential>`. In `gateway` auth mode,
billing-level API-key checks are disabled for non-webhook `/v1/*` routes only when
`BILLING_TRUST_GATEWAY_PROJECT_HEADER=true`; the gateway or upstream backend must enforce access and
send `x-billing-project-key`. Provider webhooks remain public from the billing API-key perspective
and rely on provider verification.

Dashboard/admin read routes:

- `GET /v1/admin/customers/search?q=user_1`
  Searches billing customers for support lookup. Queries are capped at 128 characters and use
  prefix matching across billing account id, internal customer id, provider customer id, transaction id,
  original transaction id, provider order id, and entitlement key.
- `GET /v1/admin/customers/by-billing-account/:billingAccountId`
  Fetches a customer drilldown by external billing account id.
- `GET /v1/admin/customers/:customerId`
  Fetches a customer drilldown by billing customer id.
- `GET /v1/admin/customers/:customerId/purchases`
  Lists purchases for one customer.
- `GET /v1/admin/customers/:customerId/subscriptions`
  Lists subscriptions for one customer.
- `GET /v1/admin/customers/:customerId/store-events`
  Lists stored provider events for one customer.
- `GET /v1/admin/customers/:customerId/projection-jobs`
  Lists projection sync jobs for one customer.
- `GET /v1/admin/purchases`
  Lists purchases across customers.
- `GET /v1/admin/subscriptions`
  Lists subscriptions across customers.
- `GET /v1/admin/store-events`
  Lists stored provider events across customers.
- `GET /v1/admin/store-events/:eventId`
  Inspects one stored provider event. `includeRawPayload=true` is supported only on this detail
  route; purchase and subscription raw blobs are not exposed in v1. Raw payload reads are
  audit-logged and common secret, signature, signed-payload, and token fields are redacted.
- `GET /v1/admin/projection-jobs`
  Lists projection sync jobs across customers.
- `GET /v1/admin/catalog/products`
  Lists billing products for read-only catalog context.
- `GET /v1/admin/catalog/store-products`
  Lists provider store products for read-only catalog context.
- `GET /v1/admin/stats/summary`
  Returns project-scoped store-event and projection-job status counts, subscription health,
  per-provider last-event timestamps, and the ten most recent store events.

Operational admin routes:

- `GET /v1/admin/catalog`
  Returns the current published catalog revision, intent hash, publication time, and complete intent.
- `POST /v1/admin/catalog/preview`
  Validates and previews one complete catalog intent without moving active pointers.
- `POST /v1/admin/catalog/publish`
  Publishes the exact previewed intent and rejects stale revisions or changed bodies.
- `POST /v1/admin/contracts/preview` and `POST /v1/admin/contracts/publish`
  Preview and publish one immutable, effective-dated customer contract version.
- `GET /v1/admin/contracts/:billingAccountId` and
  `DELETE /v1/admin/contracts/:billingAccountId/:contractId`
  Inspect or terminate published contract versions with an audit actor.
- `POST /v1/admin/catalog-migrations/preview` and
  `POST /v1/admin/catalog-migrations/publish`
  Approve durable per-subscription movement between explicit grandfathered plan versions.
- `POST /v1/admin/auto-topups/:billingAccountId/:policyId/reset`
  Reopen an automatic top-up circuit after the payment or configuration issue is resolved.

- `POST /v1/admin/store-events/:eventId/replay`
  Replays one stored provider event in the authenticated project through the configured provider
  replay path. Requires normal project auth plus `X-Billing-Operator-Key`.
- `POST /v1/admin/reconciliation/subscriptions/run`
  Runs one subscription reconciliation pass. Requires normal project auth plus
  `X-Billing-Operator-Key`.
- `POST /v1/admin/projection-jobs/:jobId/retry`
  Resets one terminal failed projection job in the authenticated project to pending. Requires
  normal project auth plus `X-Billing-Operator-Key`.
- `GET /v1/admin/metrics`
  Returns Prometheus text metrics for verification failures, webhook failures, worker jobs, and
  reconciliation runs. Requires normal project auth plus `X-Billing-Operator-Key` because the
  registry contains cross-project process metrics.
- `GET /metrics`
  Public scrape surface for the same non-customer-labelled Prometheus registry. Use this endpoint
  for VMAgent or Prometheus integrations that cannot attach admin credentials.

For production deployment, worker tuning, operational curl examples, and rollback notes, see
[production-operations.md](../quotum-docs/api/production-operations.md).
For a local Postgres 18 plus HTTP projection receiver scenario, see
[local-sandbox.md](../quotum-docs/api/local-sandbox.md).

## Run

```sh
bun run dev
```

Open:

```text
http://localhost:3000/livez
http://localhost:3000/ready
```

`/livez` is a static liveness check. `/ready` queries current Postgres health and requires the
runtime configuration's project-instance keys to exactly equal the database instance set. It
becomes unavailable during database loss and recovers without restarting the process. `/health`
remains a public liveness alias for compatibility.

The release image includes a guarded, network-free Stripe boundary for cross-service tests:

```sh
BILLING_ENV=test BILLING_TEST_FAKE_STRIPE=true \
POSTGRES_URI="postgres://postgres:postgres@127.0.0.1:5432/billing_test" \
BILLING_PROJECT_RUNTIME_JSON='[...]' bun run test:stripe-entrypoint
```

The database must already be migrated and bootstrapped, with the catalog imported or published.
The runtime JSON needs the project-instance key, projection delivery, and Stripe fields shown
above, using an `sk_test_*` key and webhook secret. Fake Checkout returns `cs_fake_*` at
`https://checkout.stripe.test`, polling returns `complete`/`paid`, and Portal returns
`https://billing.stripe.test`. Send normal signed events to
`POST /v1/projects/:projectKey/webhooks/stripe`; compute the Stripe `v1` signature as HMAC-SHA256
of `<timestamp>.<raw-body>`. Top-up event metadata uses `billingAccountId`, `productKey`, `purchaseKind`,
`externalProductId`, and `externalPriceId` (normal Checkout also carries `storeProductId` and
`billingEnvironment`), not Thru-specific `space_id` or `catalog_key` fields.

Phase 3 worker tests can configure deterministic Stripe billing behavior with
`BILLING_TEST_FAKE_STRIPE_PAYMENT_BEHAVIOR=succeeded|action_required|retryable_failure`, simulate a
missing default payment method with `BILLING_TEST_FAKE_STRIPE_DEFAULT_PAYMENT_METHOD=missing`, and
provide price amounts in minor currency units through
`BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON='{"price_credits_10":499}'`. These switches are accepted
only by the guarded test entrypoint and never by the production entrypoint.

## Internal Module Boundaries

The private-beta API is one deployable modular service backed by one Postgres database. Module and
table ownership is enforced by `bun run check:boundaries`, which parses every repository TypeScript
source with the TypeScript compiler and inspects every ordered SQL migration. Every TypeScript
source file must match exactly one owner; unclassified or overlapping files and unresolved relative
imports fail the check. Static imports, type-only imports, import types, re-exports, literal dynamic
imports, and `require` calls all count as dependencies. Compiler-resolved TypeScript path aliases,
package `imports`, absolute imports, and the package's own exports are resolved to their repository
owner as well.

| Owner | Current or reserved files | Allowed internal dependencies |
| --- | --- | --- |
| Billing | `src/admin/**`, `src/app/**`, `src/billing/**`, `src/catalog/**`, `src/db/**`, `src/http/**`, `src/observability/**`, `src/operations/**`, `src/projects/**`, `src/projections/**`, `src/providers/**`, `src/sdk/**`, `src/workers/**`, `src/env.ts`, and `scripts/billing-catalog.ts` | Billing and shared |
| Platform | `src/platform/**` | Platform and shared |
| Shared | Reserved `src/shared/**` | Shared only |
| Composition | `src/composition/**`, `src/app.ts`, `src/index.ts`, `src/platform-bootstrap.ts`, `src/runtime.ts`, `src/migrate.ts`, `src/shutdown.ts`, and `scripts/provision-catalog.ts` | Billing, platform, shared, and other composition entrypoints |
| Test support | `tests/**`, `src/testing/**`, test/scenario runners, and `scripts/lib/**` | All owners |

The policy is deny-by-default. Billing and platform cannot import one another directly, including
through the package's own SDK export, and shared code cannot depend on either domain. Production
modules cannot import composition or test-support code. The current environment, HTTP,
observability, persistence, provider, SDK, and worker code is deliberately billing-owned; it is not
made shared merely because more than one future module may need similar infrastructure.

Platform and shared code are also forbidden from importing billing persistence, Drizzle, Postgres
clients, or Bun SQL APIs; shared code therefore cannot wrap those APIs as an indirect platform
escape hatch. Platform repositories instead receive their consumer-owned, schema-neutral query
executor from composition. Every platform `executor.query` call must pass inline static SQL as
`executor.query({ text, values })`; computed, concatenated, interpolated, or otherwise indirect SQL
fails the boundary check because its table ownership cannot be proven.

Platform-owned tables use the `platform_` prefix. Static platform SQL may reference only those
tables, while billing source and billing migrations may not reference them. The sole cross-domain
SQL exception is the path-exact `src/composition/project-instance-persistence.ts` adapter. Migration
`001_platform.sql` owns the platform schema and may mutate `platform_*` plus `projects`. Every other migration is rejected if it touches a `platform_*` table. Dynamic SQL is
denied in migrations except for the reviewed usage partition block in
`003_metering_and_pricing.sql`.
Future platform-to-billing operations continue to use platform-owned typed ports with adapters wired
by composition, while direct platform-to-billing imports remain permanently denied.

## Verification

```sh
bun install
bun run check:boundaries
bun run quality
bun run test
bun run test:integration
bun run test:e2e
```

Use `bun run quality` for most code/doc changes. Run `bun run test` when touching billing behavior,
repository calls, SQL contracts, workers, or provider integrations.
Run `bun run test:integration` for comprehensive integration coverage; the runner starts a
disposable `postgres:18-alpine` Docker container, applies migrations, seeds deterministic projects
and catalog rows, executes `tests/integration`, and removes the container afterward. The suite
covers smoke/migration/catalog checks, auth and tenancy, customer entitlements, Apple, Google, and
Stripe flows, admin reads and operations, workers, idempotency/integrity, and HTTP projection
delivery. Phase 3 scenarios exercise controls, alerts, denial and correction, automatic top-up
concurrency and failure circuits, graduated and volume tiers, contracts, licenses, and catalog
migrations through the real repository and worker layers. Under plain `bun run test`, Docker-backed
integration cases remain skipped unless `RUN_POSTGRES_INTEGRATION_TESTS=1` is set.
Run `bun run test:e2e` for black-box coverage against the real `src/index.ts` service process. The
runner starts its own disposable Docker Postgres database, applies migrations, boots the service,
and enables `tests/e2e` with `RUN_BILLING_E2E_TESTS=1`. This tier covers real HTTP auth/rate-limit
edges, signed Stripe webhook ingestion, projection delivery retries, admin replay, dynamic
readiness across database loss/restore, and graceful shutdown. It also covers controls, contracts,
license assignment, rollover idempotency across restart, and automatic top-up plus catalog migration
through the guarded fake Stripe process. Under plain `bun run test`, E2E cases remain skipped.

For Apple sandbox testing, see
[apple-storekit-sandbox.md](../quotum-docs/api/apple-storekit-sandbox.md).
For Google Play license tester verification, see
[google-play-billing-test.md](../quotum-docs/api/google-play-billing-test.md).

## Release Scope and Follow-up

ADR-0001 Phases 1–3 are implemented in release `0.5.0`. The initial ADR-0003 productization slice
adds token-bound Stripe commercial actions, bounded usage reads and billing summary, the typed
backend SDK, and catalog-as-code status/diff/push. The accepted core architecture and invariants
live in [ADR-0001](../quotum-docs/adr/0001-saas-metering-and-pricing.md); the productization roadmap and its
implemented/deferred boundary live in
[ADR-0003](../quotum-docs/adr/0003-commercial-productization-patterns.md). The authoritative backend
integration contract lives in [billing-service-contract.md](../quotum-docs/api/billing-service-contract.md),
and production rollout/provider smoke checks are in
[production-operations.md](../quotum-docs/api/production-operations.md).
The accepted SaaS platform-module and platform-revenue boundaries are defined by
[ADR-0004](../quotum-docs/adr/0004-make-project-administration-database-driven.md) and
[ADR-0005](../quotum-docs/adr/0005-bill-merchant-organizations-through-an-isolated-platform-commerce-project.md).
The accepted human-identity, membership, session, staff-perimeter, and service-credential boundary
is defined by
[ADR-0006](../quotum-docs/adr/0006-separate-human-identity-membership-sessions-and-service-credentials.md).
The accepted modular-monolith, environment separation, project-scoped Postgres, shared-capacity,
and tenant-recovery boundary is defined by
[ADR-0007](../quotum-docs/adr/0007-adopt-a-modular-monolith-with-project-scoped-postgres-isolation.md).
Release `0.6.0` delivers the next ADR-0007 increment: persisted organizations, logical projects,
environment-specific project instances, database-issued credentials, database-authoritative
`ProjectInstanceContext`, exact runtime-directory readiness, and platform table ownership checks.
Release `0.7.0` integrates usage-operation recovery onto that context and migration history. It does
not include the unmerged merchant schema or identity implementation. The next increment integrates
merchant authority/provisioning through the released directory and consumer-owned module ports.
ADR-0007 remains partial. Follow integration with the schema-wide tenant-isolation audit: verify every
tenant table, composite foreign key, uniqueness constraint, project-first index/query, raw SQL path,
worker claim/completion path, provider event, and adversarial cross-project/environment case. The
broader shared-capacity, tenant-recovery, and future service-extraction gates remain later work.
The accepted responsibility, versioned retention, durable privacy-operation, tenant-export, legal-
hold, and restore-replay boundary is defined by
[ADR-0008](../quotum-docs/adr/0008-define-versioned-data-retention-privacy-operations-and-tenant-export.md).
