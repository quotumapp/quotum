# Changelog

All notable changes to the Quotum Billing API are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) with the pre-1.0 caveat that minor releases may contain
breaking changes; each entry names them and the required upgrade order.

Every release is tagged `vX.Y.Z` and published as a container image with the same version.
Before 1.0 the schema ships as baseline files under `migrations/` that evolve in place and are
checksum-verified; recreate a database from them rather than migrating it. Incremental migrations
start at 1.0.

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
