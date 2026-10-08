# Provider integrations

- Document kind: Current behavior

Connections are configured per project environment in the merchant application under
**Integrations**. The fields below describe supported connection inputs; credentials are submitted
through write-only secret fields. The selected project environment determines sandbox or production
mode.

Store product mappings must already exist before a catalog binding can adopt them. Their provisioning
is an operator prerequisite: the merchant catalog editor does not create `products` or `store_products`
rows. The development import (`quotum catalog provision`, or `bun run catalog:provision` from a
checkout) currently creates Stripe/web mappings only and skips instances with a published catalog.
Apple/iOS and Google/Android mappings require separate operator provisioning; there is no
native-store provisioning command in the current service. A store product records its billing
period as `billing_period` (`one_time` or a billing unit) and `billing_period_count`. A price
binding adopts it only when that period spans the same time as the price's interval, and so does a
`providerPriced` binding, whose provider owns the amount: a yearly plan on a monthly store product
would grant a year's allowance every month, so preview and publish refuse it with
`409 PROVIDER_BINDING_NOT_READY` naming both periods. The import takes `interval` and an optional
`intervalCount` per subscription entry.

## Paddle qualification work

Paddle is admitted for **sandbox fixed subscription checkout**. The runtime exposes hosted product
checkout and common commercial preview/execute for fixed base plans, signed webhook ingestion and stored-event replay, with normal subscription, purchase,
entitlement and `billing_state_v1` projection persistence. Only one fixed recurring item, quantity
one, without a trial is qualified. The Paddle price must have minimum and maximum quantity both
set to one; checkout validates its product, currency, amount and cadence before any write. Catalog
mappings require operator provisioning, as with native stores; the Stripe import does not create them.

On 2026-10-03, real Paddle sandbox checkouts, signed event delivery and signed projections passed.
A deliberately discarded successful transaction-create response recovered automatically with one
dispatch. Duplicate transaction delivery kept one purchase, and a replay of an old subscription event
after immediate cancellation did not restore access. These are bounded provider observations;
`tests/integration/paddle-flows.test.ts` and `tests/integration/provider-operations.test.ts` provide
repeatable database regressions. No live-account payment or production deployment was performed.

Trials, seats, multiple items, add-ons, one-time products, portal, public cancellation/change actions,
refunds, promotions, usage settlement and top-ups remain unavailable. Candidate command and
normalization helpers for those operations are not runtime support. Trusted backends and the merchant
billing port can select `provider: "paddle"` on the common commercial preview route. The merchant UI
has not adopted that choice. Fixed-plan checkout requires a published, account-visible base plan
with exactly one flat base component bound to an active Paddle subscription price; no trial,
additional paid component, paid overage or entity-scoped allocation is accepted. Quantities are
omitted/empty or the base component key with value one. The configured payment page is used;
custom return URLs, explicit expiry and promotion options are refused. See
[common commercial checkout](subscriptions.md#paddle-fixed-plan-checkout) for the request/response.

The common flow has database and HTTP regression coverage, including catalog drift, plan-version
pinning, concurrent previews, merchant receipt replay and uncertain-write recovery. On 2026-10-04,
a real quantity-one fixed-plan commercial execution created a transaction; a competing preview
returned `409 PADDLE_CHECKOUT_PENDING`. Real signed `transaction.canceled` delivery and an
authenticated transaction read closed the reservation, allowing the previously blocked preview to
create a replacement. The original receipt replayed unchanged. Both transactions were canceled,
the test customer archived, and the temporary notification setting/domain approval disabled/removed.
This check did not pay for the common-route checkout or widen the qualified lifecycle scope.
Production keys and production/internal project environments are rejected.

### Connection and payment page

The database-owned `paddle` connection uses the existing draft/validate/commit/disable lifecycle,
through the platform API or `quotum connections`. Submit `apiKey` and `webhookSecret` in `secrets`;
`notificationSettingId`, `paymentPageUrl`, `clientToken` and `webhookUrl` belong in `settings`.
The API key must be sandbox scoped (`pdl_sdbx_`), and the browser token sandbox scoped (`test_`).
Validation reads the seller's notification setting and checks its secret, active state, API version,
event subscriptions and exact destination. The URL must be public HTTPS at
`/v1/projects/:projectInstanceKey/webhooks/paddle` for the selected instance. This API check does
not claim receipt of an event; sandbox commit is permitted and real delivery must then be tested.
The required event set includes `transaction.canceled` so unpaid checkout reservations can close;
add it to existing notification settings before enabling this runtime. Losing that delivery keeps
the reservation open until the notification is replayed and authenticated state proves cancellation.
Canceled renewals and transactions without valid Quotum checkout correlation are ignored; conflicting
evidence for a correlated checkout still fails without releasing its reservation.
A checkout creates the billing account's Paddle customer from the checkout email. If Paddle already
holds an active customer for that email, Quotum links it instead, once, to the first billing account
that claims it, and refuses with `409 PADDLE_CUSTOMER_ALREADY_EXISTS` (`details.reason`: `claimed`,
`inactive`, `email_mismatch` or `ambiguous`) when it is held by another account, archived, has
another email or cannot be singled out; see [Operations](operations.md#provider-write-recovery-foundation) for the
receipt behaviour.
There is no Paddle draft-event setup receiver or production activation path in this increment.

Host Paddle.js on the approved `paymentPageUrl`, initialize it with the sandbox client token, and
configure a default payment link in the Paddle sandbox dashboard. Passing a transaction checkout
URL does not remove that prerequisite. Paddle opens the server-created transaction using `_ptxn`.
The guarded example in `src/testing/paddle-payment-page.ts` demonstrates this setup; browser
callbacks display progress and never grant access. Fulfillment uses verified server events and
current authenticated provider state.

The notification-setting ID forms the provider-account continuity anchor. Keep it stable when
rotating API keys. Write recovery decrypts the recorded validated active/retired connection version;
it never substitutes the current connection or another account. Retain old encrypted versions while
operations reference them. Missing credentials or ambiguous lookup require operator review.
See [provider write recovery](operations.md#provider-write-recovery-foundation).

### Local sandbox qualification

The read-only preflight remains available. Its owner-only JSON file contains `connection` (the five
runtime settings below), `webhookUrl`, and `bindings` matching the published local catalog. It checks
API/catalog access and always reports `qualification: "pending"`; it does not collect payment:

```sh
BILLING_ENV=test BILLING_TEST_PADDLE_SANDBOX=true \
  BILLING_TEST_PADDLE_CONFIG_FILE=/private/path/preflight.json \
  bun src/testing/paddle-preflight.ts
```

For the real runtime, use a separate owner-only regular JSON file outside Git:

```json
{
  "projectInstanceKey": "example-sandbox",
  "connection": {
    "apiKey": "<sandbox API key>",
    "webhookSecret": "<notification destination secret>",
    "notificationSettingId": "ntfset_<26-character ID>",
    "paymentPageUrl": "https://merchant.example/pay",
    "clientToken": "test_<client token>"
  },
  "connectionVersionId": "<UUID>",
  "projectionUrl": "http://127.0.0.1:4320",
  "projectionSecret": "<test receiver secret>"
}
```

Against a disposable migrated/bootstrap database with a sandbox project and provisioned mapping,
run `bun src/testing/test-paddle-entrypoint.ts` with `BILLING_ENV=test`,
`BILLING_TEST_PADDLE_SANDBOX=true`, `BILLING_TEST_PADDLE_CONFIG_FILE`, the normal database settings
and `QUOTUM_MERCHANT_ENABLED=false`. This guarded entrypoint serves the private API on loopback
4318 and `/pay` plus the exact Paddle webhook on loopback 4319. Tunnel only 4319. Its injected
projection transport permits a local test receiver; it does not change production destination rules.
After testing, cancel test subscriptions, disable the temporary notification destination, remove
its approved domain and stop the tunnel. Restore the previous default payment link when possible.
If Paddle refuses an empty default, record the stale URL and replace it with a stable approved
payment page before the next checkout. Keep credentials and raw captures
outside Git; report synthetic regressions separately from real sandbox observations.

Paddle's [default payment link](https://developer.paddle.com/build/transactions/default-payment-link/),
[signature verification](https://developer.paddle.com/webhooks/about/signature-verification/) and
[notification replay](https://developer.paddle.com/api-reference/notifications/replay-notification/)
document the provider behavior behind this flow. The capability table below is the Quotum scope.

## Provider capabilities

The table below states which billing operations each declared provider supports, under which
conditions, and which tests verify them. `bun run openapi:generate` renders it and
[`contracts/v1/provider-capabilities.json`](../contracts/v1/provider-capabilities.json) from the
capability declarations under `src/providers/`, and `bun run openapi:check` fails when either is
stale.

Catalog preview and publish check every binding of a new intent against these declarations after
its structural checks, and reject all incompatible bindings together with one
`400 PROVIDER_CAPABILITY_UNSUPPORTED`; see
[Provider capability errors](provider-capabilities.md#provider-capability-errors).

The table shows the declarations alone. The capability reads and environment readiness also require
a validated connection for every operation and, outside recovery work such as webhook ingestion, an
enabled one. Requests do not evaluate these connection conditions: a request that reaches a
provider without a usable connection fails with `BILLING_PROVIDER_NOT_CONFIGURED`, and catalog
publish does not look at connections. `GET /v1/admin/providers/capabilities` evaluates the
declarations against an environment's persisted connections, and
`GET /v1/billing-accounts/:billingAccountId/available-actions` against one billing account and its
live subscriptions. Environment readiness adds non-gating `blockerDetails` for catalog bindings the
connections cannot serve. See
[Provider capabilities and available actions](provider-capabilities.md#provider-capabilities-and-available-actions).

<!-- provider-capabilities:start -->
<!-- Generated from contracts/v1/provider-capabilities.json by bun run openapi:generate; do not edit. -->

| Operation | Apple | Google | Stripe | Paddle |
| --- | --- | --- | --- | --- |
| **Catalog** | | | | |
| Subscription products<br>`catalog.product.subscription` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | Conditional · Native<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Consumable products<br>`catalog.product.consumable` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Requires policy decision (DEC-14) · Native |
| Non-consumable products<br>`catalog.product.non_consumable` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native |
| Trials<br>`catalog.trial` | Managed by provider, mirrored by Quotum<br>Tests: [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts), [providers/apple/service](../tests/providers/apple/service.test.ts), [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Managed by provider, mirrored by Quotum<br>Tests: [providers/google/normalizer](../tests/providers/google/normalizer.test.ts), [providers/google/service](../tests/providers/google/service.test.ts), [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native |
| Add-on plans<br>`catalog.addon` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | Conditional; not implemented · Native<br>All recurring prices must share one billing interval. |
| Top-up options<br>`catalog.topup` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Requires policy decision (DEC-14) · Native |
| Flat price components<br>`catalog.price.flat` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional · Native<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Licensed-quantity prices<br>`catalog.price.licensed` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional; not implemented · Native<br>Quantities must be whole numbers. |
| Tiered prices<br>`catalog.price.tiered` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts), [billing/commercial-pricing](../tests/billing/commercial-pricing.test.ts) | Not evaluated |
| Hybrid prices<br>`catalog.price.hybrid` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional; not implemented · Native<br>All recurring prices must share one billing interval. |
| Postpaid usage prices<br>`catalog.price.postpaid_usage` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | Requires policy decision (DEC-14) · Quotum-composed via non-catalog transaction item |
| **Checkout** | | | | |
| Hosted product checkout<br>`checkout.hosted` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional · Native<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Hosted plan checkout<br>`checkout.plan` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional · Quotum-composed via checkout.hosted<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| **Purchase verification** | | | | |
| Purchase verification<br>`purchase.verify` | Supported · Native<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts), [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts), [integration/google-flows](../tests/integration/google-flows.test.ts) | Unsupported | Not evaluated |
| **Customer portal** | | | | |
| Customer portal session<br>`portal.session` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native |
| **Payment methods** | | | | |
| Hosted payment method setup<br>`payment_method.setup` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Supported · Native<br>Tests: [providers/stripe/payment-setup](../tests/providers/stripe/payment-setup.test.ts), [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Requires semantic validation (Q-SET-02) · Native |
| **Events and reconciliation** | | | | |
| Webhook ingestion<br>`webhook.ingest` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/service](../tests/providers/apple/service.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts), [providers/google/service](../tests/providers/google/service.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional · Native<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Stored event replay<br>`event.replay` | Supported · Native<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts) | Supported · Native<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts) | Supported · Native<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional · Native<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Subscription reconciliation<br>`subscription.reconcile` | Supported · Native<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts) | Supported · Native<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts), [integration/worker-flows](../tests/integration/worker-flows.test.ts) | Supported · Native<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native |
| Trial ending notice<br>`trial.ending_notice` | Supported · Quotum-composed via App Store free-trial transactions<br>Tests: [integration/worker-flows](../tests/integration/worker-flows.test.ts) | Supported · Quotum-composed via Play free-trial offer phases<br>Tests: [integration/worker-flows](../tests/integration/worker-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Not evaluated |
| **Subscription changes** | | | | |
| Subscription change preview<br>`subscription.change.preview` | Unsupported | Unsupported | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Not evaluated |
| Immediate subscription change<br>`subscription.change.apply` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [integration/promotions](../tests/integration/promotions.test.ts), [workers/recurring-billing](../tests/workers/recurring-billing.test.ts) | Unsupported |
| Period-end subscription change<br>`subscription.change.period_end` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [billing/pricing](../tests/billing/pricing.test.ts) | Unsupported |
| Subscription cancellation<br>`subscription.cancel` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period or billing_retry.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/commercial-cancellation](../tests/providers/stripe/commercial-cancellation.test.ts) | Planned · Native |
| Subscription uncancellation<br>`subscription.uncancel` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period or billing_retry.<br>The subscription must have a cancellation pending at its period end.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/commercial-cancellation](../tests/providers/stripe/commercial-cancellation.test.ts) | Not evaluated |
| Server-side subscription start<br>`subscription.create` | Unsupported | Unsupported | Supported · Native<br>Tests: [providers/stripe/payment-setup](../tests/providers/stripe/payment-setup.test.ts), [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Planned · Native |
| **Usage settlement** | | | | |
| Postpaid usage collection<br>`settlement.collect_finalized_charge` | Unsupported | Unsupported | Supported · Quotum-composed via Stripe invoices with a one-off usage line<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [workers/recurring-billing](../tests/workers/recurring-billing.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | Unsupported |
| Usage adjustment<br>`adjustment.issue` | Unsupported | Unsupported | Supported · Quotum-composed via Stripe invoices with a signed correction line<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | Unsupported |
| **Refunds** | | | | |
| Refund and reversal sync<br>`refund.sync` | Managed by provider, mirrored by Quotum<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts) | Managed by provider, mirrored by Quotum<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts), [providers/google/service](../tests/providers/google/service.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | Planned · Native |
| **Top-ups** | | | | |
| Customer-initiated top-up<br>`topup.customer_initiated` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Requires policy decision (DEC-14) · Native |
| Automatic top-up<br>`topup.automatic` | Unsupported | Unsupported | Conditional · Quotum-composed via Stripe invoices with a top-up price line<br>The customer must have a saved payment method; without one, use payment_method.setup.<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [workers/auto-topup](../tests/workers/auto-topup.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | Unsupported |
| **Promotions** | | | | |
| Promotion code applied by Quotum<br>`promotion.code_entry` | Supported · Quotum-composed via Apple subscription promotional offers<br>Tests: [integration/apple-promotions](../tests/integration/apple-promotions.test.ts) | Not evaluated | Supported · Quotum-composed via Stripe coupons applied as Checkout and subscription discounts<br>Tests: [integration/promotions](../tests/integration/promotions.test.ts), [providers/stripe/promotions](../tests/providers/stripe/promotions.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | Requires semantic validation (Q-PROMO-01) · Native |
| Hosted promotion code entry<br>`promotion.hosted_code` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/promotions](../tests/integration/promotions.test.ts), [providers/stripe/promotions](../tests/providers/stripe/promotions.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | Requires semantic validation (Q-PROMO-01) · Native |
| Signed subscription offers<br>`promotion.signed_offer` | Supported · Quotum-composed via Apple subscription promotional offers<br>Tests: [integration/apple-promotions](../tests/integration/apple-promotions.test.ts) | Unsupported | Unsupported | Unsupported |
| Native store offer codes<br>`promotion.store_offer_code` | Managed by provider, mirrored by Quotum<br>Tests: [integration/apple-promotions](../tests/integration/apple-promotions.test.ts) | Unsupported | Unsupported | Unsupported |

Billing intervals a plan can bind to, as `unit × count`; a quarter is three months and a half-year six:

- **Apple**: week × 1, month × 1–3, month × 6, year × 1
- **Google**: week × 1, week × 4, month × 1–4, month × 6, month × 8, year × 1
- **Stripe**: day × 1–1095, week × 1–156, month × 1–36, year × 1–3
- **Paddle**: day × 1–1095, week × 1–156, month × 1–36, year × 1–3

Statuses:

- **Supported**: Level is native or quotum_composed, verification is verified, and no conditions are declared.
- **Conditional**: Level is native or quotum_composed, and verification is conditional or verified with at least one condition.
- **Conditional; not implemented**: Level is native or quotum_composed, verification is planned without a blocker, and at least one condition is declared.
- **Planned**: Level is native or quotum_composed, verification is planned without a blocker, and no conditions are declared.
- **Requires policy decision**: Level is native or quotum_composed, and verification is planned with a decision blocker.
- **Requires semantic validation**: Level is native or quotum_composed, and verification is planned with a scenario or question blocker.
- **Managed by provider**: Level is provider_managed, whatever the verification.
- **Unsupported**: Level is unsupported.
- **Not evaluated**: Level is not_evaluated.

Support kinds: Native; Quotum-composed; Managed by provider, mirrored by Quotum; Unsupported; Not evaluated. A Quotum-composed cell names the provider primitive Quotum builds the operation on.

Tests link to the repository tests that exercise the declared behavior. Scenario ids name conformance scenarios; question ids and decision ids name provider assessment questions and decision register entries in the Quotum documentation repository.

Planned providers and planned statuses come from a dated provider assessment in the Quotum documentation repository and are not commitments. Provider-layer sources are cited in that assessment and are not linked from this guide.
<!-- provider-capabilities:end -->

## Apple StoreKit

- `apple.bundleId`, `apple.appAppleId` (numeric app id, required in production).
- `apple.issuerId`, `apple.keyId`, and the write-only `apple.privateKey` from the App Store Connect
  In-App Purchase key. Validation requires an EC P-256 private key.

Connection setup derives `apple.environment` from the selected environment, enforces online checks
in both modes, and uses the committed public Apple PKI roots in `src/providers/apple/certs/`.
Self-service does not expose a certificate-directory override. Production retries sandbox verification
only for signed payloads Apple rejects with an explicit environment mismatch.

Client flow:

1. The trusted backend calls `GET /v1/billing-accounts/:billingAccountId/providers/apple/account-token`
   and returns the UUID to the iOS app.
2. The app passes it as StoreKit 2 `appAccountToken` when purchasing and sends the completed
   transaction id to the backend.
3. The backend calls `POST /v1/purchases/verify` with `provider="apple"`, `billingAccountId`, and
   `transactionId`. Quotum verifies with Apple, requires the transaction's token to match the
   customer (or an already owned lineage for a tokenless native offer-code purchase), records state, enqueues projection sync, and returns the entitlement snapshot.

Configure App Store Server Notifications V2 to
`https://<billing-host>/v1/projects/<projectKey>/webhooks/apple`. Notification types that do not
change entitlements (`TEST`, `REFUND_DECLINED`, `CONSUMPTION_REQUEST`, renewal-extension summaries,
external purchase token events, Advanced Commerce metadata) are acknowledged without durable writes.
Quotum verifies each `signedPayload` against Apple's root certificates. A payload that fails
verification, or that belongs to another app or environment, answers `400 APPLE_SIGNED_DATA_INVALID`
and records nothing; a transient failure of Apple's online certificate checks answers
`503 BILLING_PROVIDER_UNAVAILABLE`. Apple retries any answer other than 200.

A notification or a reconciliation for a subscription Quotum already recorded follows the product it
was recorded against after its store mapping or product is retired, for example when
`catalog:provision` replaces a declared product: renewals, expiry, grace and billing-retry changes
and renewal-status changes still apply. A subscription Quotum has never recorded, and an event that
reports a product other than the recorded one, still need a mapping that is on sale and answer
`404 BILLING_PRODUCT_NOT_FOUND`. Refunds and revocations always followed the recorded purchase.

A transaction whose `offerDiscountType` is `FREE_TRIAL`, under any offer type (introductory,
promotional, offer code or win-back), records its purchase date and transaction expiry as the
subscription's trial. A billing grace period after the trial does not move the trial end. Later
renewals keep the recorded trial; only a later free trial that starts at or after its end replaces
it.

Apple subscription promotions link existing App Store Connect offers to an iOS discount
promotion. Signed promotional offers use the connection's private key and key ID and return an
account-bound ECDSA signature, nonce and millisecond timestamp valid for 24 hours. The subscription
must already be linked and match the mapped product and bundle. The same attempt key replays its
signature; an explicit refresh with a new key reuses the reservation and creates a fresh signature.

Native Apple offer codes need no Quotum code or signature. Verified `offerType` 2/3 and
`offerIdentifier` drive attribution through purchase verification, notifications, replay and
reconciliation. A native-code transaction without an account token requires an already owned
subscription lineage; no token is invented or attached to an unclaimed purchase. Literal native
codes are not available from the verified transaction. Retiring a mapping stops new signing while
retaining attribution; disable the offer separately in App Store Connect. Pricing, eligibility and
availability are managed there, so the merchant UI labels mappings **Linked**, not synchronized.
See [Apple subscription offers](promotions.md#apple-subscription-offers) for requests and retry
semantics.

## Google Play Billing

- `googlePlay.packageName`.
- Write-only `googlePlay.serviceAccountJson` with Android Publisher API access. Key-file paths are
  not supported by the self-service connection flow.
- Write-only `googlePlay.obfuscatedAccountIdSecret` for non-PII account ids. Self-service stores one
  current secret and does not support previous-secret overlap during rotation.
- `googlePlay.rtdnAudience`, `googlePlay.rtdnServiceAccountEmail`, `googlePlay.rtdnAuthorizedParty`,
  all required for authenticated Pub/Sub push.
- `googlePlay.enablePublisherMutations`: acknowledge and consume purchases after state is durably
  recorded.

Client flow:

1. The trusted backend calls `GET /v1/billing-accounts/:billingAccountId/providers/google/account-link`
   and returns `obfuscatedAccountId` to the Android app.
2. The app passes it with `setObfuscatedAccountId` and sends the purchase token, purchase kind, and
   product id to the backend.
3. The backend calls `POST /v1/purchases/verify` with `provider="google"`. Quotum verifies the token,
   records state, acknowledges or consumes when required, enqueues projection sync, and returns the
   entitlement snapshot.

Configure the Real-time Developer Notifications push subscription to
`https://<billing-host>/v1/projects/<projectKey>/webhooks/google`. Quotum verifies the Pub/Sub OIDC
token issuer, audience, authorized party, service-account email, and expiry. Voided purchases use a
stable `google:voided:<purchaseToken>:<eventTimeMillis>:...` event id.

A notification or a reconciliation for a subscription Quotum already recorded under its purchase
token follows the product and price mapping it was recorded against after that mapping or product is
retired, so renewals and expiry still apply. A purchase token Quotum has not recorded, including a
resubscription or upgrade under a new token, and an event that reports another product or a price
the recorded mapping does not name, still need a mapping that is on sale and answer
`404 BILLING_PRODUCT_NOT_FOUND`. Voided purchases always followed the recorded purchase.

While a subscription's line item is in a free-trial offer phase (`offerPhase.freeTrial`), Quotum
records the subscription start and the item expiry as its trial. Play reports only the current
phase, so the recorded trial stays after conversion. A new purchase token from an upgrade or
resubscription starts without the previous token's trial.

## Stripe

- Manual connections require a restricted key; standard `sk_test_` and `sk_live_` keys are rejected. Supply write-only `stripe.secretKey` (`rk_test_` for sandbox or
  `rk_live_` for production) and `stripe.webhookSecret`.
- `stripe.checkoutSuccessUrl` (must contain `{CHECKOUT_SESSION_ID}`), `stripe.checkoutCancelUrl`,
  `stripe.portalReturnUrl`, and `stripe.allowedReturnOrigins` for request-level overrides.
- `stripe.taxMode`: `disabled`, `test`, or `registered`.
- `stripe.integrationIdentifier` (defaults to `qfmxzjpa`).

When the deployment enables Stripe Apps OAuth, merchants can authorize the Stripe App defined in
[`stripe-app/stripe-app.example.json`](../stripe-app/stripe-app.example.json) instead of entering a
restricted key. OAuth tokens are encrypted per connection; the app's event signing secrets are
configured by the service operator.

Promotions need write access to Coupons and Promotion codes: grant both on a restricted key, or
approve the app version that requests `coupon_write` and `promotion_code_write`. The promotion
maintenance worker creates one coupon per discount promotion and product set, with id
`quotum_<object id>`, and a Stripe promotion code for each code marked `hostedCheckoutEnabled`.
It deactivates the Stripe code when Quotum's code is deactivated, archived, or exhausted. A changed
plan version that alters the discounted Stripe products gets a new coupon; hosted codes are
recreated on it. Objects that Stripe rejects stay `failed` with the error on
`GET /v1/admin/promotions/:promotionKey`; fix the cause and call
`POST /v1/admin/promotions/:promotionKey/provider-sync`. Stripe requires active promotion codes to
be unique in the account, so a code created in the Stripe Dashboard blocks the hosted copy.

Checkout flow:

1. The backend reads `GET /v1/catalog?provider=stripe&channel=web` and calls
   `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions` with exactly
   one `productKey` or `planKey`, licensed `quantities` for a plan, optional `email`, redirect
   overrides, an optional `expiresAt` (Unix seconds, within Stripe's 30-minute to 24-hour window),
   and an `Idempotency-Key`. The response is `{sessionId,url,duplicate}`.
2. The frontend redirects the user to Stripe.
3. Stripe posts signed events to the connection's webhook route (below); Quotum verifies
   `stripe-signature`, records paid subscription or credit-pack state, and enqueues projection sync.
4. Success pages may poll `GET .../providers/stripe/checkout-sessions/:sessionId`, which returns
   `{sessionId,status,paymentStatus,customerEmail,productKey}`; email and product key appear only
   once paid, and the endpoint never grants access. `POST .../checkout-sessions/:sessionId/expire`
   expires open sessions. A session id Stripe does not know answers `404 NOT_FOUND` on both, and a
   session that belongs to another billing account answers
   `403 STRIPE_CHECKOUT_SESSION_ACCOUNT_MISMATCH`.

A plan with no published Stripe price, such as a free plan or one sold only through an app store,
cannot be bought or switched to through Stripe: `checkout-sessions`, the `checkout_plan`,
`setup_payment` and `subscription_change` previews and a direct plan change answer
`409 PLAN_NOT_PURCHASABLE_VIA_STRIPE` naming the plan. A consumable or non-consumable Stripe product
stored without a price amount and currency answers `409 PRODUCT_NOT_PURCHASABLE_VIA_STRIPE`. Fix the
catalog or the Stripe mapping; the request is not retried.

A plan's `trialDays` becomes the Checkout subscription's trial only for an account that has not had
a trial of that plan before, through a [Quotum trial](grants.md#trials) or a provider subscription
that recorded trial bounds; otherwise the subscription starts paid and the `checkout_plan` preview
warns about it. A trial started between preview and execution makes the preview stale.

Paid one-time Checkout completion and asynchronous-success events resolve an unexpanded
PaymentIntent before recording the purchase, using the connection's PaymentIntent read permission.
The latest charge ID is stored for admin customer search; the original signed payload stays intact.
A lookup failure delays fulfillment, records a replayable event and returns a retryable provider
error. Fully discounted purchases need no charge. Duplicate deliveries may fill a missing charge
ID without issuing credits again or changing refund state; there is no bulk historical backfill.

Portal sessions come from `POST .../providers/stripe/portal-sessions` and return `{url}`.

For an existing subscription, invoice webhooks record payment history and may update its payment
status, but cannot replace its product, price, purchased items, plan version, period, or subscription
event ordering. Those commercial fields come from subscription events and reconciliation reads.
Paying an older invoice or a proration credit therefore cannot undo an upgrade. Invoice history
retains its own event order, including invoices delivered after newer subscription events.

A subscription event resolves its product and price to a store mapping that is on sale, except for
a subscription Quotum already recorded: that one keeps following its recorded product and price
after the mapping or the product is retired, for example when `catalog:provision` replaces a
declared Stripe price. Renewals, status changes, cancellations and reconciliation therefore still
apply, and the subscription stays on its plan version until the customer moves to another price. A
subscription Quotum has never recorded, and an event that reports a price other than the recorded
one, still need an active mapping and are otherwise skipped for replay.

Hosted payment-method setup uses the commercial preview and execution pair with a `setup_payment`
intent; see [Saving a payment method](subscriptions.md#saving-a-payment-method). Quotum creates a Checkout
Session in `setup` mode, card-only for the requested currency, with a 23-hour lifetime, and on the
verified completion updates only `customer.invoice_settings.default_payment_method` — Stripe's
[hosted setup flow](https://docs.stripe.com/payments/checkout/subscriptions/update-payment-details).
The connection therefore needs write access to Checkout Sessions, SetupIntents and Customers.
Send `checkout.session.completed` and `checkout.session.expired`, which the setup path shares with
Checkout purchases and promotion-code releases; the route records them and the event replay worker
applies them. The internal reconciliation task recovers a lost webhook, so a missed event delays a
saved card rather than losing it.


Subscription changes are queued with
`POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes`; upgrades and
quantity changes apply immediately by default, downgrades at period end. Base and licensed prices
are Checkout line items; metered overage is invoiced by the recurring billing worker after the
period closes. Add-ons use a separate subscription and require an active base plan, so a change
keeps the plan kind: a base subscription that names an add-on as its target, or an add-on that names
a base plan, is refused with `409 SUBSCRIPTION_CHANGE_PLAN_KIND_MISMATCH`, while a target the
project does not have, or a subscription the account does not hold, is
`404 SUBSCRIPTION_CHANGE_TARGET_NOT_FOUND`.

Refunds and disputes of a one-time purchase reverse its credits proportionally to the cumulative
reversed amount paid and are deduplicated by refund id. Configure Stripe to send `refund.created`
and `refund.updated`; `charge.refunded` is safely ignored. For promotion codes, also send
`checkout.session.expired` and
`checkout.session.async_payment_failed` so reserved uses are released promptly; the promotion
maintenance worker releases them an hour after the session could have completed otherwise. Send
`customer.subscription.trial_will_end` for [trial-ending facts](#projections); without it, Stripe
trials get no ending notice.

### Refunds of subscription payments

A refund or dispute of a subscription's payment changes nothing in Quotum, because it changes
nothing in Stripe: Stripe returns the money and leaves the subscription running, and Quotum mirrors
the subscription's own state. Access entitlements and the plan allocations granted for the paid
period stay until the subscription ends. To end access with the refund, cancel the subscription as
well, in Stripe or with an immediate [cancellation](subscriptions.md#cancelling-and-uncancelling-a-subscription).

Quotum still records the event and tells your backend. Neither the refund nor its payment names an
invoice, so Quotum asks Stripe which invoice the payment settled (`GET /v1/invoice_payments`) and
matches it to a subscription invoice recorded from `invoice.paid`. The store event is then
`processed` against that subscription, and one projection per refund or dispute carries a
`reversal` fact with `creditAmount: 0`, the refund or dispute id as `transactionId`, the payment
intent as `originalTransactionId` and the subscription's `productKey`, next to the
[`subscription` fact](#projections). A `reversal` that arrives with a `subscription` fact is a
returned subscription payment; one without it reverses a one-time purchase.

A refund or dispute Quotum cannot attribute is retried with backoff, because the purchase or
invoice event may still be on its way. After `BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS` attempts
(ten by default, about eight and a half hours) it stays `failed`, nothing was reversed, and its
`processingError` names the cause:

| `processingError` | Meaning |
| --- | --- |
| `stripe_reversal_payment_unmatched` | No one-time purchase is recorded for the payment and Stripe reports no invoice for it, as for a payment taken outside Quotum. |
| `stripe_reversal_invoice_unmatched` | The payment settled an invoice that is not recorded for a subscription: a postpaid usage invoice, an invoice from outside Quotum, or a subscription whose `invoice.paid` never arrived. |
| `stripe_reversal_invoice_lookup_failed` | Stripe refused or failed the invoice lookup. The first recording keeps the HTTP status; check that the connection can read invoices. |

`GET /v1/admin/store-events?processingStatus=failed` lists them, and
`POST /v1/admin/store-events/:eventId/replay` tries one again once its cause is fixed.

Regular provider webhooks use `/v1/projects/:projectKey/webhooks/:provider`. The project key in the
path is not a secret, so the answer never says whether it exists: an unknown key, and a project
without a connection for that provider, answer exactly what a request failing that provider's own
verification gets, after the same body and header checks (Stripe
`400 STRIPE_WEBHOOK_SIGNATURE_INVALID`, or `400 INVALID_REQUEST` without a `Stripe-Signature`; Apple
`400 APPLE_SIGNED_DATA_INVALID`; Google `401 GOOGLE_PLAY_RTDN_UNAUTHORIZED`; Paddle
`400 PADDLE_SIGNATURE_INVALID`). A Google connection saved without its push settings
(`rtdnAudience`, `rtdnServiceAccountEmail`, `rtdnAuthorizedParty`) cannot verify a sender and
answers the same way. For a known project the log keeps the real reason,
`BILLING_PROVIDER_NOT_CONFIGURED`. An inactive environment still answers
`403 ENVIRONMENT_INACTIVE`. Connection setup also exposes the version-specific route
`/v1/projects/:projectKey/connections/:versionId/webhooks/:provider` to verify the draft connection
for Apple, Google and Stripe. Paddle uses the committed sandbox connection and its regular route.
Stripe App OAuth events instead use `/v1/stripe-app/webhooks/test` or `/v1/stripe-app/webhooks/live`
when OAuth is enabled. These signed app-level events resolve the connection by Stripe account and
mode; they are not addressed by a project key.

## Headless connection setup

Without the merchant application, operators configure connections with `quotum connections` (see
the [operator CLI](deployment.md#operator-cli)). A change goes through the same draft, validation
and commit steps as the **Integrations** screens, and audit events name the operator given by
`--actor` (or `QUOTUM_ACTOR`).

1. **Write the fields to files.** Put the provider's non-secret fields (see its section above) in
   one JSON object. Put its write-only fields in another:
   - Stripe: `secretKey` (a restricted `rk_test_` or `rk_live_` key) and `webhookSecret`;
   - Apple: `privateKey`;
   - Google Play: `serviceAccountJson` and `obfuscatedAccountIdSecret`.

   A projection needs only `projectionUrl` and an optional `usageDelivery`, because Quotum generates
   its secret.
2. **Draft.** Run `quotum connections draft <instance> <kind> --settings settings.json --secrets-file -`.
   The `-` reads the secrets from stdin, so they never appear in the process list or shell history.
   - A projection draft takes `--secret-out <new-file>` instead. The generated receiver secret is
     written there, readable only by you. If the file cannot be written, nothing is drafted.
   - A provider draft prints its `setupWebhookPath`.
3. **Verify events (active production only).** An active production provider must deliver an event
   first. Point the provider's webhook at the setup path and send a test event. Then commit with
   `--wait-for-event 10m`, which waits for that event. Sandbox and inactive environments commit
   without one.
4. **Commit.** `quotum connections commit <instance> <kind> <draft-id>` validates again and
   activates the version. Then point the provider's webhook at the regular path
   `/v1/projects/<instance>/webhooks/<provider>`.

These commands, and `quotum credentials`, read `QUOTUM_AUTH_SECRET` even in headless mode. It keys
their request fingerprints the way it does for the merchant platform. While the merchant platform
runs, they refuse organizations that have members, who manage their own connections. Stripe App
OAuth needs a merchant session, so it is available only in the merchant application.

## Projections

Quotum never writes your database. It delivers signed HTTP `billing_state_v1` projections with
the entitlement and exact-string balance snapshot to the connection's projection URL, retrying
with backoff. Verify `X-Billing-Signature` and `X-Billing-Timestamp`, and treat the projection as a
read model: authorization decisions must use the metering API. Order snapshots per billing account
by `sequence`, and record `purchase`, `reversal` and `trial` facts idempotently by their key.
Usage deliveries have immutable content and an `idempotencyKey` of
`usage:<customerId>:<sequence>`; retries retain the payload, sequence and key, and subsequent
usage receives a new key. The internal coalescing job still uses `usage:<customerId>`.
Deduplicate deliveries by project and key, and compare sequence to prevent out-of-order state updates. [`scripts/projection-receiver.ts`](../scripts/projection-receiver.ts) is a
reference receiver.

### Delivery contract

The body of a delivery is published in machine-readable form next to the OpenAPI document:

- [`contracts/v1/projection-delivery.schema.json`](../contracts/v1/projection-delivery.schema.json)
  is its JSON Schema (draft 2020-12), rendered from the schema the projection worker validates a
  payload with. It covers the envelope the worker adds to the stored job payload
  (`schemaVersion`, `projectKey`, `jobId`, `idempotencyKey`), the snapshot, and the `purchase`,
  `reversal`, `trial` and `subscription` facts with the rules between them.
- [`contracts/v1/projection-delivery.examples.json`](../contracts/v1/projection-delivery.examples.json)
  holds one example per case, each with a `description` and the `delivery` body: a Stripe
  subscription's purchase, renewal, refunded payment, scheduled cancellation and end, a trial's
  start and its ending notice, a one-time purchase with its refund, a verified App Store
  subscription, a verified Google Play subscription and consumable, and a usage snapshot with a
  balance. The integration lane compares each with
  the delivery the real flow produces, field for field in structure.

Use the examples as receiver fixtures and the schema to validate what you receive. The schema
leaves objects open on purpose: a later release may add a field, so ignore the ones you do not
know instead of rejecting the delivery. Each example is a body only. Sign it yourself to test
verification, or use `quotum projections check-receiver` for the handshake.

Each entitlement's `metadata` names its source. A subscription source carries `status`,
`provider`, `channel`, `productId`, `storeProductId`, `subscriptionId`,
`externalSubscriptionId`, `productKey` and nullable `planKey`, plus `trialStartsAt` and `trialEndsAt`
(UTC ISO timestamps) when the subscription has a trial. A trialing Stripe subscription reports
`status: "active"`, and both bounds stay after the trial ends, so treat the subscription as
trialing while `trialEndsAt` is in the future. Apple and Google trials are store offers that the
catalog cannot declare; Quotum records their bounds from the store's purchase data (see
[Apple StoreKit](#apple-storekit) and [Google Play Billing](#google-play-billing)). A trial is
recorded only from a purchase Quotum sees while it runs.

An inactive entitlement keeps its last source's metadata, and its `status` says why it stopped:
the source's own status once it ended (`expired`, `refunded`, `revoked` or `voided` for a
subscription or purchase, `expired`, `ended` or `superseded` for a plan grant), or `inactive` while
that source still runs without granting the key. The latter is a key the default plan's marker
dropped, or a subscription or trial whose end passed before Quotum recorded it. An inactive
entitlement never reports a running status such as `active`; use `active` to decide access.

Stripe subscription processing also carries a `subscription` fact, including reconciliation.
It names Quotum's `subscriptionId`, `provider`, `channel`, `externalSubscriptionId`, `productKey`
and nullable pinned `planKey`, with `status`, `providerStatus`, `expiresAt`, `cancelAtPeriodEnd`
and nullable `cancellationReason`. A provider cancellation reason such as `cancellation_requested`
explains an ending without changing access-oriented status: ended access can still be `expired`.
Unknown historical reasons are null. This fact can accompany a trial fact. It is not a complete
subscription inventory or historical backfill.

Key subscription rows by `(projectKey, subscriptionId)`, or by
`(projectKey, provider, channel, externalSubscriptionId)`. Never use event/delivery IDs as row
identity. Entitlements select one source per key, so key their cache by account and entitlement key;
they cannot enumerate every subscription. A `planKey` comes from the pinned version, not today's catalog.

A payload carries at most one of the existing facts: `purchase`, `reversal` or `trial`. A `reversal` with
`creditAmount: 0` and a `subscription` fact reports a
[refunded or disputed subscription payment](#refunds-of-subscription-payments); it changes no
entitlement. A `trial` fact with
`event: "ending"` arrives once per trial, about three days before its end: for Stripe from
`customer.subscription.trial_will_end` (reason `provider_webhook`), and for Apple and Google, which
send no such notification, from the subscription reconciliation worker (reason
`expiry_reconciliation`, key `trial_ending:subscription:<id>:<trialEndsAt>`). A trial recorded when
it is already that close is announced at the next worker pass, and a trial whose end moves is
announced again for the new end. The fact names the subscription with `source: "subscription"`,
`provider`, `channel`, `externalSubscriptionId`, `productKey` and, when the subscription is on a
plan, `planKey`, and carries `trialStartsAt`, `trialEndsAt` and `autoRenew`, which says whether the
subscription continues as a paid one unless cancelled. A Stripe trial without a payment method whose
end behavior cancels or pauses it still reports `autoRenew: true`; Stripe decides at the trial end.
A [trial Quotum runs itself](grants.md#trials) is a plan grant: its entitlements carry
`source: "plan_grant"`, `origin: "trial"`, `status`, `planKey`, `planGrantId` and the trial bounds,
and its facts carry `source: "plan_grant"`, `planGrantId`, `planKey` and `autoRenew: false`. It gets
the same `ending` notice (key `trial_ending:plan_grant:<id>:<trialEndsAt>`) and an `ended` fact when
it expires (reason `expiry_reconciliation`) or is ended early (a stored `usage_changed`). Unlike the
entitlement metadata, which describes each entitlement's current source, the fact describes the one
subscription or grant whose trial is ending or has ended.

Each balance reports `periodEndsAt`, the end of its earliest allowance or meter-limit window. A
plan grant's allowance (a trial's or the default plan's) resets without a delivery, as a meter-limit
window does, so a snapshot's balance holds until its `periodEndsAt`; the next delivery, or a
balance read, reports the new window. A meter-limited feature an unlimited usage source currently
lifts carries `unlimited: true`; its `available` still reports the window's finite figure, which
applies again once the source ends.

Purchase, provider-webhook and reconciliation projections are delivered per event. Usage-driven
projections are coalesced: one delivery per billing account covers every consume, reservation and
confirmation since the previous one, is sent after the project's debounce
(`metering_settings.projection_usage_debounce_ms`, default one second), and carries the state
current at delivery, so a receiver sees fewer deliveries than usage calls. Payloads carry a
per-account `sequence`; a receiver that already applied a higher sequence for the account may
discard the snapshot but should still record any `purchase`, `reversal` or `trial` facts by their key. The
payload schema keeps `sequence` optional; treat a payload without it as unordered and apply it as
current. Set
`usageDelivery` to `off` on the projection connection when your backend takes balances from the
consume response and only needs purchase and provider events.

### Private receivers (headless only)

Receivers must be public HTTPS by default. Quotum resolves the receiver's hostname, refuses the
delivery unless every resolved address is public, and pins the request to the address it checked,
so a later lookup cannot redirect it. Loopback, link-local and cloud metadata addresses, private
ranges and IPv4-mapped or NAT64 forms of them are refused. Validating a connection whose receiver
is refused, does not resolve, or does not answer within 10 seconds fails with
`422 PROJECTION_RECEIVER_UNREACHABLE`. The answer is the same in each case, so validation does not
reveal which names resolve to private addresses. A receiver that answers without echoing the
challenge fails with `422 PROJECTION_VERIFICATION_FAILED`.

A [headless](deployment.md#headless-mode) deployment can run its backends on a private network
next to Quotum. `BILLING_PROJECTION_ALLOWED_NETWORKS` approves private networks for receivers,
such as `10.20.0.0/16` or `fd00::/8`. Each network must lie inside `10.0.0.0/8`, `100.64.0.0/10`,
`172.16.0.0/12`, `192.168.0.0/16` or `fc00::/7`. Loopback, link-local and metadata addresses can
never be approved, and an IPv4-mapped address never matches an approved IPv4 network.
`BILLING_PROJECTION_ALLOW_INSECURE_HTTP=true` also accepts `http://` receiver URLs, but only when
every resolved address is in an approved network. Public receivers always need HTTPS.

- **Server-side requests.** Quotum can then send requests into the approved networks. Anyone who
  can set a projection URL can direct them there, including through a hostname that resolves into
  those networks. Approve the narrowest networks that hold your receivers.
- **Cleartext.** Over `http://`, the projection secret travels as a bearer token and payloads
  travel unencrypted. Use it only on a network segment you trust, such as a private container
  network.
- **Headless only.** Both settings are for headless deployments. The service refuses to start
  with either of them while the merchant platform is on (`QUOTUM_MERCHANT_ENABLED` is not
  `false`), because merchants' receivers must stay on public HTTPS.

## Adding a provider

1. Complete a provider assessment from the template in the Quotum documentation repository. It
   records commercial eligibility, checkout, subscription changes, usage settlement, refunds,
   webhooks, retries, idempotency and rate limits, with a dated source for each answer and the
   questions that remain open.
2. Add `src/providers/<provider>/capabilities.ts` and list it in `src/providers/capabilities.ts`.
   Declare every operation, either at `not_evaluated` or at the support level and status the
   assessment sources. Keep `availability: "planned"` until the provider is admitted, which adds
   it to `billingProviders`, the provider CHECK constraints and the Drizzle schema in one change.
   `tests/db/provider-check-constraints.test.ts` fails until the provider CHECK constraints in the
   migrations and their Drizzle `check()` mirrors match the admitted providers; checkout requests
   admit only providers that implement checkout.
   A verified or conditional entry cites a test tagged `// capability: <operation>`.
3. Implement the `ProviderAdapter` groups in `src/providers/contract.ts` that the declaration's
   supported operations require, and add the adapter's entry to `src/providers/registry.ts`. The
   registry refuses to build an adapter that has no method for an operation its declaration marks
   as implemented.
4. Run the conformance suite against the adapter and commit its report. The suite and its reports
   arrive in a later increment; until then, tagged tests are the only accepted evidence.
5. Run `bun run openapi:generate` to regenerate
   [`contracts/v1/provider-capabilities.json`](../contracts/v1/provider-capabilities.json) and the
   table above, then `bun run openapi:check`.
6. Document the connection fields in a section of this guide, next to the existing providers, for
   the connection kind the declaration names.
7. Never add a provider branch to catalog, commercial or worker code: the declarations already
   decide. A catalog accepts a plan trial, an add-on, an explicit price component or a top-up only
   when every bound provider implements the operations that construct requires (`catalog.trial`,
   `catalog.addon`, the `catalog.price.*` operations and `catalog.topup`), and a binding's channel
   must be the one its declaration names. Auto top-up charges the customer itself only for a
   provider that implements `topup.automatic`, and queues a terminal `provider_action_required`
   job for the rest.
   A denied consume offers `purchase_required` for the providers that implement
   `topup.customer_initiated`, and a commercial preview reports the provider whose declaration
   implements that action's operation. Express a provider difference as a declared support level or
   condition instead of a branch.

### Manual Stripe restricted-key recipe

Create a restricted API key in the Stripe Dashboard for the target sandbox or live account.
Use `rk_test_` for sandbox and `rk_live_` for production. Restrict it to the following resources;
Write includes the reads used for those resources. OAuth installs are a separate connection method.

| Resource | Access | Why Quotum needs it |
| --- | --- | --- |
| Accounts | Read (`connected_account_read`) | Verify account identity, prevent conflicting connections and detect account changes |
| Products | Read | Validate adopted products |
| Prices | Read (`plan_read`) | Validate adopted prices and catalog access |
| Customers | Write | Create customers and set their default payment method |
| Checkout Sessions | Write | Create, read and expire checkout/setup sessions |
| Customer Portal | Write | Create portal sessions |
| Subscriptions | Write | Read, create, change and cancel subscriptions |
| Invoices | Write | Create, add lines, finalize, pay and void invoices |
| Payment Intents | Read | Resolve payment state |
| Setup Intents | Read | Resolve saved-card setup |
| Payment Methods | Read | Expand the saved method on Setup Intents and Customers |
| Coupons | Write | Create and read promotion coupons |
| Promotion Codes | Write | Create, read and deactivate codes |

Validation runs bounded read probes and reports all detected failures in `error.details.checks`
with `check`, `reason`, and, where relevant, `missingPermission` and `httpStatus`.
`missingPermissions` deduplicates detected missing permissions. Successful reads do not prove write
access: `unverifiedPermissions` lists write requirements to check in the Dashboard. Validation
never creates Stripe objects. This recipe covers the manual billing adapter; the Stripe App
manifest has additional installation/event permissions.

Projection verification reports the receiver's HTTP status, including 401, 404 and 503, or an
invalid acknowledgment/challenge reason for an HTTP 200. A status is a diagnostic clue, not proof
that the secret or route is wrong. Receiver bodies and credential values are not returned.

To test a receiver without drafting or committing a connection:

```sh
quotum projections check-receiver https://backend.example --project-key example-sandbox --secret-file receiver-secret.txt
```

The file contains the raw shared secret (or use `--secret-file -` for stdin). The command appends
`/internal/billing/projections/verify` to the base URL and checks a valid challenge, wrong bearer,
invalid signature and expired timestamp. Negative authentication checks must return 401 or 403.
It prints each result, exits nonzero on failure, and sends no billing snapshots. Public HTTPS
receivers are the default. Headless operators may use the existing
`BILLING_PROJECTION_ALLOWED_NETWORKS` / `BILLING_PROJECTION_ALLOW_INSECURE_HTTP` policy with
`QUOTUM_MERCHANT_ENABLED=false`. The reference receiver implements the same handshake.
