# Changelog

All notable changes to the Quotum Billing API are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) with the pre-1.0 caveat that minor releases may contain
breaking changes; each entry names them and the required upgrade order.

Every release is tagged `vX.Y.Z` and published as a container image with the same version.
Before 1.0 the schema ships as baseline files under `migrations/` that evolve in place and are
checksum-verified; recreate a database from them rather than migrating it. Incremental migrations
start at 1.0.

## [Unreleased]

### Platform email configuration (breaking)

- Added explicit `QUOTUM_EMAIL_PROVIDER=cloudflare|resend` selection and a Resend REST adapter.
  Resend requires `QUOTUM_EMAIL_RESEND_API_KEY` and the shared `QUOTUM_EMAIL_FROM` sender address.
- Renamed `MERCHANT_AUTH_SECRET` to `QUOTUM_AUTH_SECRET`, `MERCHANT_EMAIL_FROM` to
  `QUOTUM_EMAIL_FROM`, and Cloudflare's `MERCHANT_EMAIL_ACCOUNT_ID` / `MERCHANT_EMAIL_API_TOKEN`
  to `QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID` / `QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN`. Old names are
  rejected. These configure Quotum's own sender and authentication, not merchant registration.
- Upgrade configuration and application together: set the explicit provider, remove retired keys
  from the new process environment, and preserve the auth secret's exact value. Retain old image
  and configuration together for rollback. No database migration is required for this change.

### Added

- `bun run test:load`, a load lane that boots the real service against a disposable Postgres and
  measures the metering hot path (hot account, spread accounts, reserve and confirm, check, workers
  idle) with client and server latency, Postgres statistics, statements per request, projection
  fan-out and CPU. `--profile [consume|check]` lists every statement one request executes and
  `--pg-config` passes Postgres settings to the container, and `--recreate-schema` lets a reused
  external database be started over. See the operations guide.
- `BILLING_POSTGRES_PREPARED_STATEMENTS` (default `true`) to disable named prepared statements
  behind a transaction-mode pooler that cannot hold them.
- `usageDelivery` on projection connections (`coalesced` by default, or `off`) and the per-project
  `metering_settings.projection_usage_debounce_ms` tunable (default 1000).
- A per-account `sequence` on every projection payload so receivers can discard a stale snapshot.
- The reference projection receiver tracks each account's `sequence` and flags an older snapshot
  as stale while still acknowledging it.
- Self-contained quickstart under `examples/quickstart/` that runs the service against a local
  Postgres with the guarded fake Stripe boundary, publishes a catalog, records a synthetic
  purchase, and meters usage without provider accounts.
- `.env.example` documenting every production environment variable.
- In-repository guides under `docs/` for deployment and configuration, provider integrations, the
  API, operations (backup, restore, upgrade, rollback), and architecture.

### Changed

- Format the platform and merchant baseline SQL with one column or table constraint per line.
  The schema is unchanged, but the file checksums change; recreate disposable development/test
  databases under the pre-1.0 baseline policy.
- Production now requires explicit, nonblank `MERCHANT_ORIGIN` and `MERCHANT_PUBLIC_URL`,
  including when `BILLING_ENV` is unset. Set both deployment URLs before upgrading; startup
  no longer falls back to Quotum domains in production.
- The consume path issues statements that depend only on known identifiers together, so the
  driver pipelines them in one round trip, and no longer reads the customer twice, the feature
  twice, or the customer three more times for the projection payload. One consume went from 33
  statements in 31 round trips to 26 statements in about 14, and its post-write balance is now
  computed from the rows it locked. On the load lane's laptop container one hot account went from
  about 80 to about 220 consumes per second and spread traffic from about 670 to about 1,200.
- Named prepared statements are on by default; pipelining depends on them.
- Every JSON parameter is bound as text and cast on the server (`::text::jsonb`), including the
  `jsonb()` helper, the catalog provisioner and the integration fixtures. A driver that infers
  parameter types from a prepared statement would otherwise encode the serialized string a second
  time and store a JSON string scalar.
- Effective control resolution runs as one statement with the active contract resolved inline.
- Usage-driven projections are coalesced: one job per billing account with no stored payload,
  delivered after the project's debounce with the entitlements and balances read at delivery
  time. A consume no longer reads or serializes the projection payload. Purchase, provider-webhook
  and reconciliation projections keep their per-event identity. Receivers get fewer deliveries
  than consumes and must apply each one idempotently; the payload schema is unchanged apart from
  the added `sequence`.
- The projection claim ranks fairness inside a candidate set bounded by the batch size and read
  through the partial indexes on due and stale jobs, so its cost no longer grows with the backlog.
- Admin projection job listings return `payload: null` for pending usage-driven jobs; the OpenAPI
  contract is regenerated.
- Usage operations pipeline the claim read and the caller's non-blocking reads behind the advisory
  lock, run the customer upsert and the expired-reservation sweep together once the lock is held,
  and send the claim insert ahead of the mutation's first batch: about 10 round trips per consume
  instead of 14 with the same statements. Only reads that cannot wait on a row lock precede the
  lock check, so a competing operation with the same identity still learns it is in progress
  without blocking. Laptop throughput stayed within run variance; the saving grows with database
  round-trip time.
- The reserve and confirm paths use the same pipelined shape as consume: shared subject
  resolution, hold and confirmation writes issued together with the snapshot reads behind them,
  prefetched alerts and top-up policy, and a control-hold confirmation that pipelines its lock and
  reads. A reserve-and-confirm pair went from 72 to 58 statements and from 23 to 17 ms on the
  profile; the load lane measured 359 to 582 pairs per second at concurrency 64.

### Fixed

- Projection job claims could hand one job to two workers: the due predicate lived only in the
  ranking CTE, so when one worker committed its claim while another was selecting, the newer row
  version passed the join-only recheck. The locking select and the update now repeat the predicate.
- The pinned Stripe API version follows stripe 22.6.2.
- Usage calls no longer rewrite and lock the customer row: the customer lookup reads first and
  inserts only a missing customer. The per-call upsert held the row lock for the rest of the
  transaction, so the projection worker's sequence update and the next call on the same account
  queued behind each other; against a database 87 ms away one hot account took four seconds per
  consume.
- Confirming a reservation updated the consumed quantity on every reservation holding the same
  allocation, not only its own, which understated the held quantity those other reservations later
  released. The update is now scoped to the confirming reservation.

## [0.9.0] - 2026-09-09

### Added

- Self-service provider connections: merchants connect Stripe through OAuth and store encrypted
  provider and projection credentials per environment (platform connection tables in `001_platform.sql`).
- Connection secret rotation (`bun run connections:rotate-secrets`), Stripe App event intake,
  and production activation from the merchant platform.
- Scoped Stripe Checkout expiration: optional `expiresAt` on session creation and
  `POST .../providers/stripe/checkout-sessions/:sessionId/expire`.

### Changed

- The service starts and reports ready before any customer is onboarded; customer readiness is
  tracked per connection.

### Removed

- `BILLING_PROJECT_RUNTIME_JSON`. Supplying it is rejected at startup; configure integrations
  through the merchant platform instead. Existing identities and billing data are unaffected.

## [0.8.1] - 2026-09-08

### Added

- Generated OpenAPI contract (`contracts/v1/openapi.json`) and runtime error inventory
  (`contracts/v1/errors.json`) covering every implemented route, produced by
  `bun run openapi:generate` from module-owned Zod schemas.
- `bun run openapi:check` and `bun run openapi:lint`, plus a CI diff report against the base
  revision.

## [0.8.0] - 2026-09-07

### Added

- Merchant platform: session authentication with email OTP and Google sign-in, step-up grants for
  sensitive actions, team membership, onboarding, transactional email, and a service-principal
  script for the merchant proxy (`004_merchant.sql`).
- Merchant integration test suite under `integration/merchant/`.
- Reservation safeguards: confirming more than the reserved quantity returns
  `RESERVATION_QUANTITY_EXCEEDED`, changed confirmations return `RESERVATION_ALREADY_CONFIRMED`,
  and expired holds are reclaimed transactionally.
- `METER_RATE_NOT_ACTIVATED` guard preventing implicit repricing when an account uses a newly
  published meter absent from its purchased catalog.

### Changed

- Production requires merchant authentication configuration (`MERCHANT_AUTH_SECRET`,
  `MERCHANT_ORIGIN`, approved legal versions, and email transport).

## [0.7.0] - 2026-09-06

### Added

- Durable usage-operation recovery for consume, reserve, confirm, release, and correction
  (recovery columns on `client_idempotency_claims`): same-input replays return the original result,
  conflicting input returns `409 IDEMPOTENCY_CONFLICT`, and
  `GET .../usage/operations/:operation/:operationId` exposes the retained outcome.
- SDK support through `client.usage.getOperation`.

### Upgrade

- Drain usage writers and metering-maintenance workers, recreate the database from the baseline
  files, then start the new build. Do not run old and new writers together.

## [0.6.0] - 2026-09-05

### Added

- Database-authoritative organizations, logical projects, environment-specific project instances,
  and one-way-hashed project credentials (`001_platform.sql`).
- `bun run platform:bootstrap` for exact-manifest topology and one-time credential issuance.
- `BILLING_CATALOG_IMPORT_JSON` with `bun run catalog:provision` for development catalog imports.

### Changed

- Request and worker context resolves from the database instead of static configuration.

### Upgrade

- Recreate databases from the baseline files; pre-1.0 releases do not migrate data in place.

## [0.5.2] - 2026-09-04

### Added

- `bun run check:boundaries`, enforcing module ownership, dependency direction, SQL placement, and
  migration rules; it runs inside `bun run quality` and in CI.
- CI gate that runs the operator console contract checks against each API change.

## [0.5.0] - 2026-09-03

First release under the `quotum-api` name.

### Added

- Apple StoreKit 2 and Google Play Billing purchase verification with App Store Server
  Notifications V2 and Real-time Developer Notifications webhooks.
- Stripe Checkout, Customer Portal, webhooks, invoice tracking, and idempotent plan and seat
  changes for web billing.
- Entitlement resolution and HTTP `billing_state_v1` projection delivery to product backends.
- Fixed-decimal metering with check, consume, reserve, confirm, release, and correction APIs,
  capped meter windows, wallet rate cards, and deterministic allocation receipts.
- Recurring pricing: fixed recurring fees, included allowances, licensed quantities, hybrid
  plans, trials and add-ons, proration rules, and postpaid overage invoices.
- Customer controls, usage alerts, automatic top-ups with circuit state, enterprise contracts,
  customer-specific plans, grandfathered catalog migrations, and license pools.
- Operator-protected versioned catalog preview and publish, commercial previews, billing
  summaries, usage series, and a typed backend SDK with a catalog-as-code CLI.
- Projection, provider replay, subscription reconciliation, metering maintenance, recurring billing,
  and automatic top-up workers with lease heartbeats.
- Baseline schema files with strict checksum verification and advisory-locked application.
- Unit, Postgres-backed integration, and black-box end-to-end test suites.
