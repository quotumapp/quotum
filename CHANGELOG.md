# Changelog

All notable changes to the Quotum Billing API are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) with the pre-1.0 caveat that minor releases may contain
breaking changes; each entry names them and the required upgrade order.

Every release is tagged `vX.Y.Z` and published as a container image with the same version.
Before 1.0 the schema ships as baseline files under `migrations/` that evolve in place and are
checksum-verified; recreate a database from them rather than migrating it. Incremental migrations
start at 1.0.

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
