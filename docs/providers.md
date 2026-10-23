# Provider integrations

- Document kind: Current behavior

Connections are configured per project environment in the merchant application under
**Integrations**. The fields below describe supported connection inputs; credentials are submitted
through write-only secret fields. The selected project environment determines sandbox or production
mode.

Store product mappings must already exist before a catalog binding can adopt them. Their provisioning
is an operator prerequisite: the merchant catalog editor does not create `products` or `store_products`
rows. The development import (`quotum catalog provision`, or `bun run catalog:provision` from a
checkout) creates Stripe/web mappings only and skips instances with a published catalog. Stripe
products are adopted with `quotum catalog bindings adopt`, and so are Apple/iOS and Google/Android
products, which you
[declare](catalog.md#register-an-app-store-or-google-play-product) because neither store offers a
product lookup. Paddle mappings still require separate operator provisioning. A store product records its billing
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
mappings require operator provisioning; neither the Stripe import nor `bindings adopt` creates them.

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
Paddle has no draft-event setup receiver and remains sandbox-only.

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
and `QUOTUM_CONSOLE_ENABLED=false`. This guarded entrypoint serves the private API on loopback
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

Every cell separates **Today**, the scope Quotum implements, from **Potential**, a dated assessment
of what the provider's current APIs could support. Potential is research metadata, never permission
to run an operation or a delivery commitment. It includes native primitives, Quotum composition,
external customer flows, eligibility restrictions and unresolved semantic or policy questions.
An operation unavailable in Quotum may still have a conditional future implementation: Google
Publisher refunds, eligible Apple Advanced Commerce refund requests and Paddle lifecycle writes
are examples. Paddle's current sandbox-only qualification remains explicit under Today.

The optional `operations[operation].feasibility` object contains `status`, `reason`, `sources`
(`title`, `url`) and `reviewedOn`. Every generated provider-operation pair has an assessment; older
schema-version-1 contracts may omit it, which means Unknown. Source URLs and review dates are
committed research, not fetched or timestamped during generation. Runtime verdicts continue to use
`level`, `verification`, `conditions`, connection state and request facts.

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

Each cell separates **Today** (Quotum implementation) from **Potential** (provider feasibility). Potential describes current provider APIs and documented primitives; it does not enable an operation or promise delivery.

| Operation | Apple | Google | Stripe | Paddle |
| --- | --- | --- | --- | --- |
| **Catalog** | | | | |
| Subscription products<br>`catalog.product.subscription` | **Today:** Supported · Native<br>**Potential:** Possible. Auto-renewable products can fund plans whose entitlements Quotum mirrors.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/)<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Auto-renewing base plans can fund subscription entitlements mirrored by Quotum.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions)<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Recurring prices fund subscription entitlements tracked by Quotum.<br>Reviewed 2026-10-22 · [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/overview)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | **Today:** Conditional · Native<br>Sandbox only; one fixed recurring item with quantity one and no trial. Real Paddle checkout and signed projection delivery observed.<br>Sandbox fixed subscription scope. Other product types and lifecycle actions remain unavailable until separately qualified.<br>**Potential:** Possible. Recurring Paddle prices support subscription products; Quotum's present qualification remains sandbox-only.<br>Reviewed 2026-10-22 · [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price)<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Consumable products<br>`catalog.product.consumable` | **Today:** Supported · Native<br>**Potential:** Possible. Consumable purchases can fund app-owned balances after server verification.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/)<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. A verified one-time purchase can grant a consumable balance before the purchase is consumed.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate)<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. One-time payments can fund consumable grants; Quotum owns the balance.<br>Reviewed 2026-10-22 · [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Requires policy decision (DEC-14) · Native<br>Paddle must confirm that software-usage credit packs are acceptable products.<br>**Potential:** Conditional. One-time products can fund app-owned credits; merchant eligibility, credit terms and DEC-14 still need review.<br>Reviewed 2026-10-22 · [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/), [Paddle acceptable use policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) |
| Non-consumable products<br>`catalog.product.non_consumable` | **Today:** Not assessed in Quotum<br>StoreKit normalizes non-consumable transactions, but no test exercises one.<br>**Potential:** Possible. Non-consumable purchases support lasting access; Quotum would need to qualify that fulfillment path.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/) | **Today:** Not assessed in Quotum<br>Play normalization accepts non-consumable products, but no test exercises a completed one.<br>**Potential:** Possible. Unconsumed one-time purchases can fund lasting access; Quotum still needs a qualified fulfillment path.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate) | **Today:** Supported · Native<br>Non-consumable products are provisioned Stripe web store products sold through product Checkout.<br>**Potential:** Possible. One-time payments can fund lasting access tracked by Quotum.<br>Reviewed 2026-10-22 · [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Planned · Native<br>**Potential:** Possible. A one-time transaction can fund lasting access maintained by Quotum.<br>Reviewed 2026-10-22 · [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price), [Paddle transaction checkout](https://developer.paddle.com/build/transactions/pass-transaction-checkout) |
| Trials<br>`catalog.trial` | **Today:** Provider-managed; mirrored by Quotum<br>Free-trial offers (introductory, promotional, offer code or win-back) run in the App Store; Quotum records the trial bounds from the signed transaction. The catalog rejects plan trial days on Apple bindings.<br>**Potential:** Provider-managed only. Store introductory offers own trial eligibility and duration; they cannot honor arbitrary Quotum trial-end policies.<br>Reviewed 2026-10-22 · [Subscription offers](https://developer.apple.com/app-store/subscriptions/#subscription-offers)<br>Tests: [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts), [providers/apple/service](../tests/providers/apple/service.test.ts), [integration/apple-flows](../tests/integration/apple-flows.test.ts) | **Today:** Provider-managed; mirrored by Quotum<br>Free trials are offers on Play base plans; Quotum records the trial bounds while the subscription is in its free-trial offer phase. The catalog rejects plan trial days on Google bindings.<br>**Potential:** Provider-managed only. Play offers determine trial phases and eligibility; arbitrary Quotum trial-end behavior is not a publisher command.<br>Reviewed 2026-10-22 · [Subscription products and offers](https://developer.android.com/google/play/billing/subscriptions#base-plans-offers)<br>Tests: [providers/google/normalizer](../tests/providers/google/normalizer.test.ts), [providers/google/service](../tests/providers/google/service.test.ts), [integration/google-flows](../tests/integration/google-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Conditional. Subscription trials support payment-method and trial-end policies that must match the plan.<br>Reviewed 2026-10-22 · [Subscription trials](https://docs.stripe.com/billing/subscriptions/trials)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Planned · Native<br>Trial access follows subscription lifecycle state, separately from paid fulfilment.<br>**Potential:** Conditional. Recurring prices support trials; payment-method requirements and trial-end parity need validation.<br>Reviewed 2026-10-22 · [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price) |
| Add-on plans<br>`catalog.addon` | **Today:** Not assessed in Quotum<br>The catalog accepts add-on plans only when every binding is Stripe.<br>**Potential:** Conditional. Separate subscription groups or eligible Advanced Commerce items could supply add-ons; Quotum's base-plan and lifecycle parity need qualification.<br>Reviewed 2026-10-22 · [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/), [Advanced Commerce eligibility](https://developer.apple.com/in-app-purchase/advanced-commerce-api/) | **Today:** Not assessed in Quotum<br>The catalog accepts add-on plans only when every binding is Stripe.<br>**Potential:** Conditional. Play supports native subscription add-ons with cadence and country restrictions; separate Quotum add-on subscriptions and base-plan gating need qualification.<br>Reviewed 2026-10-22 · [Subscriptions with add-ons](https://developer.android.com/google/play/billing/subscription-with-addons) | **Today:** Supported · Native<br>An add-on is a separate Stripe subscription and requires an active base plan.<br>**Potential:** Possible. An additional subscription can sell an add-on; Quotum enforces the base-plan prerequisite.<br>Reviewed 2026-10-22 · [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/overview)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | **Today:** Not implemented · Conditional; not implemented · Native<br>All recurring prices must share one billing interval.<br>All recurring items in one Paddle subscription must share a billing period.<br>**Potential:** Possible. Recurring add-ons can be separate subscriptions with a Quotum-enforced base-plan prerequisite.<br>Reviewed 2026-10-22 · [Recurring add-ons](https://developer.paddle.com/build/subscriptions/add-remove-products-prices-addons) |
| Top-up options<br>`catalog.topup` | **Today:** Supported · Native<br>**Potential:** Possible. Consumable products can grant a fixed quantity to a balance maintained by Quotum.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/)<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Consumable one-time products can replenish balances managed by Quotum.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate)<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. A one-time price can fund a metered balance maintained by Quotum.<br>Reviewed 2026-10-22 · [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | **Today:** Not implemented · Requires policy decision (DEC-14) · Native<br>Paddle must confirm that software-usage credit packs are acceptable products.<br>**Potential:** Conditional. One-time software-usage credits are technically composable; merchant eligibility and DEC-14 remain open.<br>Reviewed 2026-10-22 · [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/), [Paddle acceptable use policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) |
| Flat price components<br>`catalog.price.flat` | **Today:** Not assessed in Quotum<br>The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Conditional. Storefront-specific product prices can represent a flat fee; explicit Quotum amount and currency bindings need validation.<br>Reviewed 2026-10-22 · [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/) | **Today:** Not assessed in Quotum<br>The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Conditional. Base-plan prices can represent a flat fee; exact Quotum price bindings need storefront/currency validation.<br>Reviewed 2026-10-22 · [Subscription products and offers](https://developer.android.com/google/play/billing/subscriptions#base-plans-offers) | **Today:** Supported · Native<br>**Potential:** Possible. Fixed recurring prices map to explicit flat components.<br>Reviewed 2026-10-22 · [Stripe pricing models](https://docs.stripe.com/products-prices/pricing-models)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Conditional · Native<br>Sandbox only; one fixed recurring item with quantity one and no trial. Real Paddle checkout and signed projection delivery observed.<br>Sandbox fixed subscription scope. Other product types and lifecycle actions remain unavailable until separately qualified.<br>**Potential:** Possible. Fixed recurring prices support explicit flat subscription components.<br>Reviewed 2026-10-22 · [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price)<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Licensed-quantity prices<br>`catalog.price.licensed` | **Today:** Unavailable in Quotum<br>Seat pricing is not an App Store capability. The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Unknown. StoreKit has fixed products; licensed-quantity parity through Advanced Commerce has not been established.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Seat pricing is not a Google Play capability. The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Unavailable through current provider APIs. Auto-renewing subscriptions do not expose a licensed-seat quantity; one-time multi-quantity purchases do not supply that recurring contract.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate), [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Supported · Native<br>**Potential:** Possible. Per-seat recurring prices accept an explicit quantity.<br>Reviewed 2026-10-22 · [Stripe pricing models](https://docs.stripe.com/products-prices/pricing-models)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Conditional; not implemented · Native<br>Quantities must be whole numbers.<br>Paddle quantities are whole numbers; Quotum keeps seat allocation authority.<br>**Potential:** Possible. Subscription line-item quantities can represent licensed seats within price quantity bounds.<br>Reviewed 2026-10-22 · [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price), [Update a subscription](https://developer.paddle.com/api-reference/subscriptions/update-subscription) |
| Tiered prices<br>`catalog.price.tiered` | **Today:** Not assessed in Quotum<br>The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Unknown. Fixed store prices do not establish provider-side volume or graduated pricing; Advanced Commerce parity is unassessed.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Not assessed in Quotum<br>The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Unavailable through current provider APIs. Play base plans expose fixed offer phases, not provider-side volume or graduated recurring prices.<br>Reviewed 2026-10-22 · [Subscription products and offers](https://developer.android.com/google/play/billing/subscriptions#base-plans-offers) | **Today:** Supported · Native<br>Stripe prices tiered in-advance lines during Checkout; Quotum rates tiered postpaid overage itself.<br>**Potential:** Possible. Volume and graduated prices support quantity-based tiers.<br>Reviewed 2026-10-22 · [Stripe pricing models](https://docs.stripe.com/products-prices/pricing-models)<br>Tests: [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts), [billing/commercial-pricing](../tests/billing/commercial-pricing.test.ts) | **Today:** Not assessed in Quotum<br>The Paddle assessment does not cover tiered prices.<br>**Potential:** Unknown. Externally rated tiered usage is documented, but binding an exact provider-side volume or graduated price is unassessed.<br>Reviewed 2026-10-22 · [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/), [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price) |
| Hybrid prices<br>`catalog.price.hybrid` | **Today:** Unavailable in Quotum<br>Hybrid pricing is not an App Store capability. The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Unknown. Advanced Commerce supports multiple subscription items, but licensed or metered-overage parity is unassessed.<br>Reviewed 2026-10-22 · [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Hybrid pricing is not a Google Play capability. The catalog accepts explicit price components only on Stripe bindings.<br>**Potential:** Unknown. Multiple subscription items exist, but the required licensed or metered-overage components have no established equivalent.<br>Reviewed 2026-10-22 · [Subscriptions with add-ons](https://developer.android.com/google/play/billing/subscription-with-addons) | **Today:** Supported · Native<br>**Potential:** Possible. Multiple subscription items can combine fixed, quantity and usage charges.<br>Reviewed 2026-10-22 · [Stripe pricing models](https://docs.stripe.com/products-prices/pricing-models), [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/overview)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Conditional; not implemented · Native<br>All recurring prices must share one billing interval.<br>Base and seat items share one subscription and one billing period; metered overage follows postpaid usage settlement.<br>**Potential:** Conditional. Recurring items and custom usage charges can compose a hybrid bill; timing and recovery parity need qualification.<br>Reviewed 2026-10-22 · [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/), [Charge a subscription](https://developer.paddle.com/api-reference/subscriptions/create-subscription-charge) |
| Postpaid usage prices<br>`catalog.price.postpaid_usage` | **Today:** Unavailable in Quotum<br>App Store purchases cannot carry postpaid usage invoices.<br>**Potential:** Unavailable through current provider APIs. StoreKit and Advanced Commerce start purchases in the app; they expose no arbitrary off-session usage invoice for Quotum.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Google Play purchases cannot carry postpaid usage invoices.<br>**Potential:** Unavailable through current provider APIs. Native base plans do not accept an arbitrary usage invoice after a Quotum metering period.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Supported · Native<br>**Potential:** Possible. Quotum can rate usage and invoice the finalized amount through Stripe.<br>Reviewed 2026-10-22 · [Create and collect invoices](https://docs.stripe.com/invoicing/integration)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | **Today:** Not implemented · Requires policy decision (DEC-14) · Quotum-composed via non-catalog transaction item<br>Quotum keeps usage rating and bills the finalized amount as one non-catalog item with quantity one, so fractional usage is never rounded into Paddle quantities.<br>**Potential:** Conditional. Quotum-rated overage can become a custom charge; Paddle's beta usage balances alone do not bill overage. DEC-14 remains open.<br>Reviewed 2026-10-22 · [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/), [Charge a subscription](https://developer.paddle.com/api-reference/subscriptions/create-subscription-charge) |
| **Checkout** | | | | |
| Hosted product checkout<br>`checkout.hosted` | **Today:** Unavailable in Quotum<br>Purchases start in the app through StoreKit and reach Quotum through purchase verification.<br>**Potential:** Unavailable through current provider APIs. Apple starts these purchases through StoreKit, without a server-created hosted checkout session.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit) | **Today:** Unavailable in Quotum<br>Purchases start in the app through Google Play Billing and reach Quotum through purchase verification.<br>**Potential:** Unavailable through current provider APIs. Play Billing launches a native purchase sheet, without a server-created hosted checkout session.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate) | **Today:** Supported · Native<br>**Potential:** Possible. Checkout supports hosted one-time and subscription payments.<br>Reviewed 2026-10-22 · [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Conditional · Native<br>Sandbox only; one fixed recurring item with quantity one and no trial. Real Paddle checkout and signed projection delivery observed.<br>Sandbox fixed subscription scope. Other product types and lifecycle actions remain unavailable until separately qualified.<br>**Potential:** Conditional. A server-created transaction opens in Paddle Checkout on an approved payment page.<br>Reviewed 2026-10-22 · [Paddle transaction checkout](https://developer.paddle.com/build/transactions/pass-transaction-checkout)<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Hosted plan checkout<br>`checkout.plan` | **Today:** Unavailable in Quotum<br>Purchases start in the app through StoreKit and reach Quotum through purchase verification.<br>**Potential:** Unavailable through current provider APIs. Recurring purchases require the native StoreKit purchase flow, including Advanced Commerce creation.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Purchases start in the app through Google Play Billing and reach Quotum through purchase verification.<br>**Potential:** Unavailable through current provider APIs. A base plan is purchased through the native Play Billing flow.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate) | **Today:** Supported · Native<br>**Potential:** Possible. Checkout can start a subscription with the plan's recurring line items.<br>Reviewed 2026-10-22 · [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Conditional · Quotum-composed via checkout.hosted<br>Sandbox common preview/execute only; one fixed base-plan component at quantity one without trial or promotion.<br>Sandbox fixed subscription scope. The stored commercial preview pins the provider connection and plan version; fulfillment awaits signed provider events.<br>**Potential:** Conditional. Recurring transaction items can start a plan; full trials, quantities and multi-item parity need qualification.<br>Reviewed 2026-10-22 · [Paddle transaction checkout](https://developer.paddle.com/build/transactions/pass-transaction-checkout), [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price)<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| **Purchase verification** | | | | |
| Purchase verification<br>`purchase.verify` | **Today:** Supported · Native<br>The transaction's app account token must match the token Quotum issued for the billing account.<br>**Potential:** Possible. Signed transactions and authenticated server reads can verify purchases and their ownership.<br>Reviewed 2026-10-22 · [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts), [integration/apple-flows](../tests/integration/apple-flows.test.ts) | **Today:** Supported · Native<br>Quotum acknowledges or consumes the purchase after recording it only when publisher mutations are enabled on the connection.<br>**Potential:** Possible. Publisher purchase reads plus acknowledgement or consumption can verify and fulfill purchases.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate), [Play Developer API](https://developers.google.com/android-publisher/api-ref/rest)<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts), [integration/google-flows](../tests/integration/google-flows.test.ts) | **Today:** Unavailable in Quotum<br>Stripe purchases complete in hosted Checkout and are recorded from signed webhook events; the Checkout Session status route never grants access.<br>**Potential:** Conditional. A native payment could be verified by retrieving its PaymentIntent; trusted account correlation and fulfillment would need a new Quotum flow.<br>Reviewed 2026-10-22 · [Retrieve a PaymentIntent](https://docs.stripe.com/api/payment_intents/retrieve) | **Today:** Not assessed in Quotum<br>Paddle purchases are web checkouts fulfilled from webhooks; the assessment covers no client-submitted purchase verification.<br>**Potential:** Unknown. Authenticated transaction reads exist, but a distinct native purchase submission and account-correlation contract is unassessed.<br>Reviewed 2026-10-22 · [Get a transaction](https://developer.paddle.com/api-reference/transactions/get-transaction) |
| **Customer portal** | | | | |
| Customer portal session<br>`portal.session` | **Today:** Not assessed in Quotum<br>**Potential:** Provider-managed only. Apple supplies subscription-management UI; no Quotum-created billing portal session exposes the defined self-service surface.<br>Reviewed 2026-10-22 · [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/) | **Today:** Not assessed in Quotum<br>**Potential:** Provider-managed only. Play supplies subscription-management screens and deep links, not a Quotum-created billing portal session.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Supported · Native<br>**Potential:** Possible. Authenticated portal sessions expose customer billing self-service.<br>Reviewed 2026-10-22 · [Stripe customer portal](https://docs.stripe.com/customer-management)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Planned · Native<br>Portal sessions are created on demand; their authenticated URLs are never stored.<br>**Potential:** Possible. The API creates authenticated customer portal sessions.<br>Reviewed 2026-10-22 · [Create a portal session](https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session) |
| **Payment methods** | | | | |
| Hosted payment method setup<br>`payment_method.setup` | **Today:** Provider-managed; no Quotum command<br>The App Store owns the Apple ID payment method; there is no Quotum-hosted setup and nothing for Quotum to make default.<br>**Potential:** Provider-managed only. Apple owns the customer's payment account; Quotum cannot save or choose its default payment method.<br>Reviewed 2026-10-22 · [Apple Account payment methods](https://support.apple.com/118293) | **Today:** Provider-managed; no Quotum command<br>Google Play owns the account's payment methods; there is no Quotum-hosted setup and nothing for Quotum to make default.<br>**Potential:** Provider-managed only. Google manages the customer's payment methods; Quotum cannot choose the account's default collection method.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Supported · Native<br>Hosted Checkout in \`setup\` mode saves a card without a charge; on the verified completion Quotum sets it as the Stripe customer's invoice default payment method and leaves subscription-specific methods untouched.<br>**Potential:** Possible. Checkout setup mode saves a payment method without a charge; Quotum can set the invoice default.<br>Reviewed 2026-10-22 · [Set up future payments](https://docs.stripe.com/payments/checkout/save-and-reuse)<br>Tests: [providers/stripe/payment-setup](../tests/providers/stripe/payment-setup.test.ts), [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | **Today:** Not implemented · Requires semantic validation (Q-SET-02) · Native<br>Paddle saves a payment method through its own hosted transaction; whether Quotum can start one without a charge and promote the result to the account default is unresolved.<br>**Potential:** Unknown. Updating a subscription's payment method is documented; no-charge setup and an account-wide collection default need semantic validation (Q-SET-02).<br>Reviewed 2026-10-22 · [Update payment details](https://developer.paddle.com/build/subscriptions/update-payment-details) |
| **Events and reconciliation** | | | | |
| Webhook ingestion<br>`webhook.ingest` | **Today:** Supported · Native<br>**Potential:** Possible. Signed server notifications expose subscription and transaction changes.<br>Reviewed 2026-10-22 · [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/service](../tests/providers/apple/service.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. RTDN and authenticated purchase reads expose lifecycle changes.<br>Reviewed 2026-10-22 · [Real-time developer notifications](https://developer.android.com/google/play/billing/rtdn-reference)<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts), [providers/google/service](../tests/providers/google/service.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Signed payment and subscription events can drive local state.<br>Reviewed 2026-10-22 · [Stripe webhooks](https://docs.stripe.com/webhooks)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Conditional · Native<br>Sandbox only; one fixed recurring item with quantity one and no trial. Real Paddle checkout and signed projection delivery observed.<br>Sandbox fixed subscription scope. Other product types and lifecycle actions remain unavailable until separately qualified.<br>**Potential:** Possible. Signed notifications expose transaction and subscription lifecycle changes.<br>Reviewed 2026-10-22 · [Paddle webhook delivery](https://developer.paddle.com/webhooks/overview)<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Stored event replay<br>`event.replay` | **Today:** Supported · Native<br>**Potential:** Possible. Quotum can retain authenticated notifications and reprocess them locally.<br>Reviewed 2026-10-22 · [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Quotum can retain authenticated notifications and replay them locally with fresh provider state.<br>Reviewed 2026-10-22 · [Real-time developer notifications](https://developer.android.com/google/play/billing/rtdn-reference)<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Quotum can persist and reprocess authenticated webhook payloads locally.<br>Reviewed 2026-10-22 · [Stripe webhooks](https://docs.stripe.com/webhooks)<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Conditional · Native<br>Sandbox only; one fixed recurring item with quantity one and no trial. Real Paddle checkout and signed projection delivery observed.<br>Sandbox fixed subscription scope. Other product types and lifecycle actions remain unavailable until separately qualified.<br>**Potential:** Possible. Quotum can persist and reprocess authenticated Paddle event payloads locally.<br>Reviewed 2026-10-22 · [Paddle webhook delivery](https://developer.paddle.com/webhooks/overview)<br>Tests: [integration/paddle-flows](../tests/integration/paddle-flows.test.ts) |
| Subscription reconciliation<br>`subscription.reconcile` | **Today:** Supported · Native<br>**Potential:** Possible. The server API exposes transaction history and subscription status for reconciliation.<br>Reviewed 2026-10-22 · [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Subscription purchase reads expose authoritative state and line items.<br>Reviewed 2026-10-22 · [Get a subscription purchase](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get)<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts), [integration/worker-flows](../tests/integration/worker-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. The subscription API exposes authoritative state for local reconciliation.<br>Reviewed 2026-10-22 · [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/overview)<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts) | **Today:** Not implemented · Planned · Native<br>**Potential:** Possible. Authenticated subscription reads expose current provider state.<br>Reviewed 2026-10-22 · [Get a subscription](https://developer.paddle.com/api-reference/subscriptions/get-subscription) |
| Trial ending notice<br>`trial.ending_notice` | **Today:** Supported · Quotum-composed via App Store free-trial transactions<br>App Store sends no trial-ending notification; the subscription reconciliation worker sends the notice three days before the recorded trial end.<br>**Potential:** Possible. Quotum can derive a notice from the verified trial period, without a dedicated Apple ending event.<br>Reviewed 2026-10-22 · [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi), [Subscription offers](https://developer.apple.com/app-store/subscriptions/#subscription-offers)<br>Tests: [integration/worker-flows](../tests/integration/worker-flows.test.ts) | **Today:** Supported · Quotum-composed via Play free-trial offer phases<br>Play sends no trial-ending notification; the subscription reconciliation worker sends the notice three days before the recorded trial end.<br>**Potential:** Possible. Offer phases and recorded expiry let Quotum derive a trial-ending notice.<br>Reviewed 2026-10-22 · [Subscription products and offers](https://developer.android.com/google/play/billing/subscriptions#base-plans-offers), [Subscription lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions)<br>Tests: [integration/worker-flows](../tests/integration/worker-flows.test.ts) | **Today:** Supported · Native<br>Attached to customer.subscription.trial_will_end, which the webhook endpoint or Stripe App event destination must send.<br>**Potential:** Possible. Trial-ending webhook events can trigger a Quotum notice.<br>Reviewed 2026-10-22 · [Subscription webhook events](https://docs.stripe.com/billing/subscriptions/webhooks)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | **Today:** Not assessed in Quotum<br>The Paddle assessment does not cover trial-ending notices.<br>**Potential:** Possible. Recorded trial bounds can drive a Quotum notice without a dedicated provider event.<br>Reviewed 2026-10-22 · [Paddle prices](https://developer.paddle.com/api-reference/prices/create-price) |
| **Subscription changes** | | | | |
| Subscription change preview<br>`subscription.change.preview` | **Today:** Unavailable in Quotum<br>Upgrades, downgrades and crossgrades are priced in the App Store purchase sheet; Quotum has no preview for them and records no preview outcome.<br>**Potential:** Provider-managed only. StoreKit presents purchase terms to the customer; server-side proration previews matching Quotum are not exposed.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/) | **Today:** Unavailable in Quotum<br>Plan changes are priced in the Google Play purchase sheet; Quotum has no preview for them and records no preview outcome.<br>**Potential:** Provider-managed only. Play displays replacement pricing in the purchase flow; a matching server-side proration preview is not exposed.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>The target plan must be the same kind as the current plan and publish Stripe base or licensed prices. Stripe calculates the final proration amount during execution.<br>**Potential:** Possible. Invoice previews expose the financial effect of subscription updates.<br>Reviewed 2026-10-22 · [Preview an invoice](https://docs.stripe.com/api/invoices/create_preview)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | **Today:** Not assessed in Quotum<br>The Paddle assessment does not cover previewing subscription updates.<br>**Potential:** Possible. The subscription preview API calculates update charges before a write.<br>Reviewed 2026-10-22 · [Preview a subscription update](https://developer.paddle.com/api-reference/subscriptions/preview-subscription-update) |
| Immediate subscription change<br>`subscription.change.apply` | **Today:** Provider-managed; no Quotum command<br>Upgrades and crossgrades happen in the App Store; Quotum records the resulting subscription notifications.<br>**Potential:** Provider-managed only. Plan replacements use native purchase flows; Advanced Commerce subscription modification also runs in the app.<br>Reviewed 2026-10-22 · [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Provider-managed; no Quotum command<br>Plan changes happen in Google Play and arrive as a new purchase token linked to the replaced one.<br>**Potential:** Provider-managed only. Replacement modes act through a customer-facing native purchase and a linked purchase token.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>The target plan must be the same kind as the current plan and publish Stripe base or licensed prices. The recurring billing worker applies the change with its Stripe proration behavior.<br>**Potential:** Conditional. Subscription updates support price and quantity changes with explicit billing and proration policies.<br>Reviewed 2026-10-22 · [Change subscription prices](https://docs.stripe.com/billing/subscriptions/change-price)<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [integration/promotions](../tests/integration/promotions.test.ts), [workers/recurring-billing](../tests/workers/recurring-billing.test.ts) | **Today:** Unavailable in Quotum<br>Planned for a later increment; this adapter has no durable dispatcher for this operation.<br>**Potential:** Conditional. Updates support item replacement and billing modes; renewal exclusion, collection and uncertain-write recovery require qualification.<br>Reviewed 2026-10-22 · [Update a subscription](https://developer.paddle.com/api-reference/subscriptions/update-subscription) |
| Period-end subscription change<br>`subscription.change.period_end` | **Today:** Provider-managed; no Quotum command<br>Downgrades are scheduled in the App Store; Quotum records the renewal preference notification.<br>**Potential:** Provider-managed only. Apple determines when native subscription replacements take effect; Quotum cannot dispatch an arbitrary deferred plan change.<br>Reviewed 2026-10-22 · [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Provider-managed; no Quotum command<br>Deferred plan changes are scheduled in Google Play; Quotum records the resulting purchase state.<br>**Potential:** Provider-managed only. Deferred replacements are chosen in the native purchase flow; Quotum mirrors the resulting state.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions) | **Today:** Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>The target plan must be the same kind as the current plan and publish Stripe base or licensed prices. Downgrades default to the end of the current period, when the recurring billing worker applies them.<br>**Potential:** Possible. Subscription schedules or Quotum's worker can apply a change at a period boundary.<br>Reviewed 2026-10-22 · [Subscription schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [billing/pricing](../tests/billing/pricing.test.ts) | **Today:** Unavailable in Quotum<br>Planned for a later increment; this adapter has no durable dispatcher for this operation.<br>**Potential:** Conditional. A Quotum worker could apply an update at renewal; exact boundary timing and billing semantics remain unvalidated.<br>Reviewed 2026-10-22 · [Update a subscription](https://developer.paddle.com/api-reference/subscriptions/update-subscription) |
| Subscription cancellation<br>`subscription.cancel` | **Today:** Provider-managed; no Quotum command<br>Cancellation happens in the store's subscription settings; Quotum records the resulting notification.<br>**Potential:** Conditional. Eligible apps can stop renewal through Advanced Commerce after signing its addendum; immediate no-refund cancellation parity is unassessed.<br>Reviewed 2026-10-22 · [Cancel through Advanced Commerce](https://developer.apple.com/documentation/advancedcommerceapi/cancel-a-subscription), [Advanced Commerce eligibility](https://developer.apple.com/in-app-purchase/advanced-commerce-api/) | **Today:** Provider-managed; no Quotum command<br>Cancellation happens in the store's subscription settings; Quotum records the resulting notification.<br>**Potential:** Conditional. Publisher cancellation can stop renewals; immediate no-refund termination and cancellation-mode parity need validation.<br>Reviewed 2026-10-22 · [Cancel a subscription purchase](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/cancel) | **Today:** Conditional · Native<br>The subscription state must be active, grace_period or billing_retry.<br>An immediate cancellation ends the Stripe subscription with no proration credit and no closing invoice; a period-end cancellation sets \`cancel_at_period_end\`. A queued change for the subscription is superseded, and a base plan cannot be cancelled while add-on subscriptions are active.<br>**Potential:** Possible. Cancellation supports immediate termination or stopping renewal at period end.<br>Reviewed 2026-10-22 · [Cancel subscriptions](https://docs.stripe.com/billing/subscriptions/cancel)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/commercial-cancellation](../tests/providers/stripe/commercial-cancellation.test.ts) | **Today:** Not implemented · Planned · Native<br>Paddle cancels immediately or at the next billing period; whether an immediate cancellation refunds the paid period is not assessed.<br>**Potential:** Possible. Cancellation can take effect immediately or at the next billing period.<br>Reviewed 2026-10-22 · [Cancel a subscription](https://developer.paddle.com/build/subscriptions/cancel-subscriptions) |
| Subscription uncancellation<br>`subscription.uncancel` | **Today:** Provider-managed; no Quotum command<br>Resubscribing before the period ends happens in the store's subscription settings; Quotum records the resulting notification.<br>**Potential:** Provider-managed only. Reactivation requires a customer-facing StoreKit or Advanced Commerce in-app flow, rather than a generic backend command.<br>Reviewed 2026-10-22 · [Auto-renewable subscriptions](https://developer.apple.com/app-store/subscriptions/), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Provider-managed; no Quotum command<br>Resubscribing before the period ends happens in the store's subscription settings; Quotum records the resulting notification.<br>**Potential:** Provider-managed only. Customer resubscription through Play can restore renewal; it is not a generic backend clear-cancellation command.<br>Reviewed 2026-10-22 · [Subscription lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions) | **Today:** Conditional · Native<br>The subscription state must be active, grace_period or billing_retry.<br>The subscription must have a cancellation pending at its period end.<br>Clearing \`cancel_at_period_end\` only restores renewal; it does not restore a subscription change the cancellation superseded, and a subscription Stripe already ended cannot be cleared.<br>**Potential:** Conditional. A pending period-end cancellation can be cleared before the subscription ends.<br>Reviewed 2026-10-22 · [Cancel subscriptions](https://docs.stripe.com/billing/subscriptions/cancel)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/commercial-cancellation](../tests/providers/stripe/commercial-cancellation.test.ts) | **Today:** Not assessed in Quotum<br>The Paddle assessment does not cover clearing a scheduled cancellation.<br>**Potential:** Conditional. An update can remove a scheduled cancellation while the subscription remains active.<br>Reviewed 2026-10-22 · [Update a subscription](https://developer.paddle.com/api-reference/subscriptions/update-subscription) |
| Server-side subscription start<br>`subscription.create` | **Today:** Unavailable in Quotum<br>The App Store starts subscriptions in its own purchase sheet. Quotum cannot start one on a saved card.<br>**Potential:** Unavailable through current provider APIs. Subscription creation requires an in-app purchase, including Advanced Commerce; no silent saved-card start is exposed.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Google Play starts subscriptions in its own purchase sheet. Quotum cannot start one on a saved card.<br>**Potential:** Unavailable through current provider APIs. A new subscription requires a native customer purchase, not an off-session charge initiated by Quotum.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate) | **Today:** Supported · Native<br>After hosted setup saves a card, Quotum calls subscriptions.create with payment_behavior error_if_incomplete and off_session. A decline or authentication requirement leaves the card saved and records payment_failed; no subscription is stored. A plan version that changed after the preview records plan_changed instead of starting.<br>**Potential:** Conditional. The subscription API can bill a saved method; collection may still require customer authentication.<br>Reviewed 2026-10-22 · [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/overview), [Set up future payments](https://docs.stripe.com/payments/checkout/save-and-reuse)<br>Tests: [providers/stripe/payment-setup](../tests/providers/stripe/payment-setup.test.ts), [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | **Today:** Not implemented · Planned · Native<br>Paddle creates subscriptions from paid transactions or issued invoices and has no direct create-subscription operation.<br>**Potential:** Unknown. Subscriptions normally follow paid recurring transactions; starting one off-session on a saved method needs separate proof.<br>Reviewed 2026-10-22 · [Paddle transaction checkout](https://developer.paddle.com/build/transactions/pass-transaction-checkout), [Saved payment methods](https://developer.paddle.com/build/checkout/saved-payment-methods) |
| **Usage settlement** | | | | |
| Postpaid usage collection<br>`settlement.collect_finalized_charge` | **Today:** Unavailable in Quotum<br>App Store purchases cannot carry postpaid usage invoices.<br>**Potential:** Unavailable through current provider APIs. Native purchases do not offer an off-session invoice for an arbitrary finalized usage amount.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Google Play purchases cannot carry postpaid usage invoices.<br>**Potential:** Unavailable through current provider APIs. Play Billing has no arbitrary postpaid subscription-usage invoice endpoint.<br>Reviewed 2026-10-22 · [Play subscriptions](https://developer.android.com/google/play/billing/subscriptions), [Play Developer API](https://developers.google.com/android-publisher/api-ref/rest) | **Today:** Supported · Quotum-composed via Stripe invoices with a one-off usage line<br>Quotum rates the overage after the usage period closes, then finalizes and pays the invoice against the subscription.<br>**Potential:** Possible. Quotum can place its finalized usage amount on an invoice and collect it.<br>Reviewed 2026-10-22 · [Create and collect invoices](https://docs.stripe.com/invoicing/integration)<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [workers/recurring-billing](../tests/workers/recurring-billing.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | **Today:** Unavailable in Quotum<br>Planned for a later increment; this adapter has no durable dispatcher for this operation.<br>**Potential:** Conditional. One-time subscription charges can collect a Quotum-rated amount; DEC-14, correlation and uncertain-write recovery still block parity.<br>Reviewed 2026-10-22 · [Charge a subscription](https://developer.paddle.com/api-reference/subscriptions/create-subscription-charge), [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/) |
| Usage adjustment<br>`adjustment.issue` | **Today:** Unavailable in Quotum<br>Adjustments apply to postpaid usage invoices, which App Store purchases cannot carry.<br>**Potential:** Unavailable through current provider APIs. There is no postpaid usage invoice to correct; refund requests are a separate capability.<br>Reviewed 2026-10-22 · [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Adjustments apply to postpaid usage invoices, which Google Play purchases cannot carry.<br>**Potential:** Unavailable through current provider APIs. Play has no usage invoice to adjust; order refunds and revocations are separate operations.<br>Reviewed 2026-10-22 · [Play Developer API](https://developers.google.com/android-publisher/api-ref/rest), [Refund an order](https://developers.google.com/android-publisher/api-ref/rest/v3/orders/refund) | **Today:** Supported · Quotum-composed via Stripe invoices with a signed correction line<br>Late usage corrections invoice the rated difference for the closed period: a negative difference finalizes without payment and a positive one is paid like a period charge.<br>**Potential:** Possible. Invoice items and credit notes provide primitives for signed usage corrections.<br>Reviewed 2026-10-22 · [Create and collect invoices](https://docs.stripe.com/invoicing/integration), [Credit notes](https://docs.stripe.com/invoicing/dashboard/credit-notes)<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | **Today:** Unavailable in Quotum<br>Planned for a later increment; this adapter has no durable dispatcher for this operation.<br>**Potential:** Conditional. Refund/credit adjustments and extra charges offer correction primitives; signed-difference semantics and DEC-14 need validation.<br>Reviewed 2026-10-22 · [Paddle adjustments](https://developer.paddle.com/api-reference/adjustments/create-adjustment), [Charge a subscription](https://developer.paddle.com/api-reference/subscriptions/create-subscription-charge) |
| **Refunds** | | | | |
| Refund and reversal sync<br>`refund.sync` | **Today:** Provider-managed; mirrored by Quotum<br>Apple decides refunds; Quotum mirrors refund, revocation and refund reversal notifications.<br>**Potential:** Possible. Refund and revocation notifications plus refund-history reads can drive balance reversals.<br>Reviewed 2026-10-22 · [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications), [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts) | **Today:** Provider-managed; mirrored by Quotum<br>Refunds and revocations happen in Google Play; Quotum mirrors voided purchase notifications, including partial consumable refunds.<br>**Potential:** Possible. Voided purchase notifications and reads can reverse refunded or revoked purchase grants.<br>Reviewed 2026-10-22 · [Real-time developer notifications](https://developer.android.com/google/play/billing/rtdn-reference), [Voided purchases](https://developers.google.com/android-publisher/voided-purchases)<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts), [providers/google/service](../tests/providers/google/service.test.ts) | **Today:** Supported · Native<br>Refunds reverse the credits the payment funded in proportion to the cumulative amount reversed, never below what is spent or held, deduplicated by refund id. Disputes reverse a one-time purchase only.<br>**Potential:** Possible. Refund and dispute events can be reconciled to their original payment and grants.<br>Reviewed 2026-10-22 · [Stripe webhooks](https://docs.stripe.com/webhooks), [Create a refund](https://docs.stripe.com/api/refunds/create)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/stripe-subscription-refund](../tests/integration/stripe-subscription-refund.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | **Today:** Not implemented · Planned · Native<br>Refunds arrive as adjustments whose approval state can change after creation.<br>**Potential:** Possible. Adjustment notifications and reads can mirror refunds and disputes into Quotum.<br>Reviewed 2026-10-22 · [Paddle adjustments](https://developer.paddle.com/api-reference/adjustments/create-adjustment), [Paddle webhook delivery](https://developer.paddle.com/webhooks/overview) |
| Quotum-issued refund<br>`refund.issue` | **Today:** Provider-managed; no Quotum command<br>Quotum uses the standard StoreKit customer-refund flow and sends no refund command; eligible Advanced Commerce refund requests are not integrated.<br>**Potential:** Conditional. Advanced Commerce permits server refund requests for eligible apps with the signed addendum; approval and Quotum amount/recovery parity need qualification. Standard StoreKit keeps the customer-request flow.<br>Reviewed 2026-10-22 · [Request a transaction refund](https://developer.apple.com/documentation/advancedcommerceapi/request-transaction-refund), [Advanced Commerce eligibility](https://developer.apple.com/in-app-purchase/advanced-commerce-api/) | **Today:** Provider-managed; no Quotum command<br>Google Play can refund an order through its API, but Quotum has not built the call; refund in Play Console and Quotum mirrors the voided purchase.<br>**Potential:** Conditional. Publisher order refunds and subscription revocation exist; arbitrary-amount, proration and durable recovery parity need validation.<br>Reviewed 2026-10-22 · [Refund an order](https://developers.google.com/android-publisher/api-ref/rest/v3/orders/refund), [Revoke a subscription purchase](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/revoke) | **Today:** Supported · Native<br>Quotum creates the Stripe refund under the execution idempotency key and records the request; one refund may be open per payment and the amount never exceeds what was paid net of earlier refunds. The connection needs write access to Refunds.<br>**Potential:** Possible. The refund API returns all or part of a payment, up to its unrefunded amount.<br>Reviewed 2026-10-22 · [Create a refund](https://docs.stripe.com/api/refunds/create)<br>Tests: [integration/stripe-refund-requests](../tests/integration/stripe-refund-requests.test.ts), [providers/stripe/commercial-refund](../tests/providers/stripe/commercial-refund.test.ts) | **Today:** Unavailable in Quotum<br>Planned for a later increment; this adapter has no durable dispatcher for this operation.<br>**Potential:** Conditional. Refund adjustments support full or partial amounts, usually subject to Paddle approval; durable recovery is still required.<br>Reviewed 2026-10-22 · [Paddle adjustments](https://developer.paddle.com/api-reference/adjustments/create-adjustment) |
| **Top-ups** | | | | |
| Customer-initiated top-up<br>`topup.customer_initiated` | **Today:** Supported · Native<br>The customer buys a consumable top-up through StoreKit.<br>**Potential:** Possible. A customer can buy a consumable through StoreKit to replenish a Quotum balance.<br>Reviewed 2026-10-22 · [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/)<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | **Today:** Supported · Native<br>The customer buys a consumable top-up through Google Play Billing.<br>**Potential:** Possible. A customer can buy a consumable in Play Billing to replenish a Quotum balance.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate)<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | **Today:** Supported · Native<br>**Potential:** Possible. Checkout can sell a one-time credit pack; Quotum credits it after payment.<br>Reviewed 2026-10-22 · [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | **Today:** Not implemented · Requires policy decision (DEC-14) · Native<br>Paddle must confirm that software-usage credit packs are acceptable products.<br>**Potential:** Conditional. One-time checkout can fund app-owned credits; merchant eligibility and DEC-14 remain unresolved.<br>Reviewed 2026-10-22 · [Paddle for AI companies](https://developer.paddle.com/get-started/how-paddle-works/ai-companies/), [Paddle acceptable use policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) |
| Automatic top-up<br>`topup.automatic` | **Today:** Unavailable in Quotum<br>Silent automatic purchases are unavailable; Apple automatic top-up jobs end as provider_action_required.<br>**Potential:** Unavailable through current provider APIs. Creating a new consumable charge requires a native customer purchase; existing subscription renewal is a different operation.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Advanced Commerce API](https://developer.apple.com/documentation/advancedcommerceapi) | **Today:** Unavailable in Quotum<br>Silent automatic purchases are unavailable; Google automatic top-up jobs end as provider_action_required.<br>**Potential:** Unavailable through current provider APIs. A new consumable purchase requires the native customer flow; subscription renewal is not a silent top-up purchase.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate) | **Today:** Conditional · Quotum-composed via Stripe invoices with a top-up price line<br>The customer must have a saved payment method; without one, use payment_method.setup.<br>Quotum pays a Stripe invoice with the customer's default payment method; a missing method or an authentication request ends the job as action required.<br>**Potential:** Conditional. An off-session invoice can charge a saved method; authentication or payment failure requires customer action.<br>Reviewed 2026-10-22 · [Create and collect invoices](https://docs.stripe.com/invoicing/integration), [Set up future payments](https://docs.stripe.com/payments/checkout/save-and-reuse)<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [workers/auto-topup](../tests/workers/auto-topup.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | **Today:** Unavailable in Quotum<br>Planned for a later increment; this adapter has no durable dispatcher for this operation.<br>**Potential:** Conditional. An automatically collected subscription charge is a candidate; saved-method consent, eligibility, DEC-14 and write recovery need validation.<br>Reviewed 2026-10-22 · [Charge a subscription](https://developer.paddle.com/api-reference/subscriptions/create-subscription-charge), [Paddle acceptable use policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) |
| **Promotions** | | | | |
| Promotion code applied by Quotum<br>`promotion.code_entry` | **Today:** Supported · Quotum-composed via Apple subscription promotional offers<br>Mapped iOS discount codes return a signed StoreKit action. Direct feature and plan grants remain unsupported.<br>**Potential:** Conditional. Quotum codes can map to eligible signed StoreKit promotional offers; redemption still requires a verified native purchase.<br>Reviewed 2026-10-22 · [Subscription offers](https://developer.apple.com/app-store/subscriptions/#subscription-offers)<br>Tests: [integration/apple-promotions](../tests/integration/apple-promotions.test.ts) | **Today:** Not assessed in Quotum<br>Quotum passes no discount to Google Play; Android code redemption executes feature grants in Quotum only.<br>**Potential:** Conditional. Quotum codes could select developer-determined Play offers; client offer-token handling, eligibility and discount parity need validation.<br>Reviewed 2026-10-22 · [Subscription products and offers](https://developer.android.com/google/play/billing/subscriptions#base-plans-offers) | **Today:** Supported · Quotum-composed via Stripe coupons applied as Checkout and subscription discounts<br>Quotum validates and reserves the code, then applies the promotion's Stripe coupon to the Checkout Session or subscription change.<br>**Potential:** Possible. Quotum can map validated codes to coupons applied to Checkout or subscriptions.<br>Reviewed 2026-10-22 · [Coupons and promotion codes](https://docs.stripe.com/billing/subscriptions/coupons)<br>Tests: [integration/promotions](../tests/integration/promotions.test.ts), [providers/stripe/promotions](../tests/providers/stripe/promotions.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | **Today:** Not implemented · Requires semantic validation (Q-PROMO-01) · Native<br>Paddle has discount entities; stacking, product scope and duration parity with Quotum promotions is unvalidated.<br>**Potential:** Conditional. Discount entities exist; scope, stacking and duration parity remain unvalidated (Q-PROMO-01).<br>Reviewed 2026-10-22 · [Paddle discounts](https://developer.paddle.com/api-reference/discounts/create-discount) |
| Hosted promotion code entry<br>`promotion.hosted_code` | **Today:** Not assessed in Quotum<br>**Potential:** Unavailable through current provider APIs. Apple's native offer-code sheet is not a provider-hosted web checkout with Quotum promotion entry.<br>Reviewed 2026-10-22 · [StoreKit](https://developer.apple.com/documentation/storekit), [Subscription offers](https://developer.apple.com/app-store/subscriptions/#subscription-offers) | **Today:** Not assessed in Quotum<br>**Potential:** Unavailable through current provider APIs. Play's native promotion redemption is not a provider-hosted web checkout.<br>Reviewed 2026-10-22 · [Play Billing integration](https://developer.android.com/google/play/billing/integrate) | **Today:** Supported · Native<br>The connection needs write access to Stripe Coupons and Promotion codes.<br>**Potential:** Possible. Checkout can accept Stripe promotion codes and report the applied discount.<br>Reviewed 2026-10-22 · [Coupons and promotion codes](https://docs.stripe.com/billing/subscriptions/coupons), [Stripe Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works)<br>Tests: [integration/promotions](../tests/integration/promotions.test.ts), [providers/stripe/promotions](../tests/providers/stripe/promotions.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | **Today:** Not implemented · Requires semantic validation (Q-PROMO-01) · Native<br>**Potential:** Conditional. Checkout accepts discount codes; Quotum redemption limits and reporting parity need validation (Q-PROMO-01).<br>Reviewed 2026-10-22 · [Paddle discounts](https://developer.paddle.com/api-reference/discounts/create-discount) |
| Signed subscription offers<br>`promotion.signed_offer` | **Today:** Supported · Quotum-composed via Apple subscription promotional offers<br>Requires an active mapping and an existing linked subscription; a signature reserves one use for 24 hours, and StoreKit confirms the purchase.<br>**Potential:** Conditional. StoreKit promotional offers accept server signatures, subject to customer and subscription eligibility.<br>Reviewed 2026-10-22 · [Subscription offers](https://developer.apple.com/app-store/subscriptions/#subscription-offers)<br>Tests: [integration/apple-promotions](../tests/integration/apple-promotions.test.ts) | **Today:** Unavailable in Quotum<br>**Potential:** Unavailable through current provider APIs. Play offer tokens do not implement Apple's signed subscription-offer protocol.<br>Reviewed 2026-10-22 · [Subscription products and offers](https://developer.android.com/google/play/billing/subscriptions#base-plans-offers) | **Today:** Unavailable in Quotum<br>**Potential:** Unavailable through current provider APIs. Apple's signed subscription-offer protocol has no Stripe equivalent; coupons are a different operation.<br>Reviewed 2026-10-22 · [Coupons and promotion codes](https://docs.stripe.com/billing/subscriptions/coupons) | **Today:** Unavailable in Quotum<br>**Potential:** Unavailable through current provider APIs. Paddle discounts do not implement Apple's signed subscription-offer protocol.<br>Reviewed 2026-10-22 · [Paddle discounts](https://developer.paddle.com/api-reference/discounts/create-discount) |
| Native store offer codes<br>`promotion.store_offer_code` | **Today:** Provider-managed; mirrored by Quotum<br>App Store Connect owns offer codes; Quotum records one mapped use per linked subscription.<br>**Potential:** Provider-managed only. Apple controls offer-code distribution and redemption; Quotum can mirror the resulting verified purchase.<br>Reviewed 2026-10-22 · [Offer codes](https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/offer-codes-for-in-app-purchases)<br>Tests: [integration/apple-promotions](../tests/integration/apple-promotions.test.ts) | **Today:** Unavailable in Quotum<br>**Potential:** Conditional. Play promotion redemption exists; mapping a redeemed code from authoritative purchase data needs validation.<br>Reviewed 2026-10-22 · [Play promotions](https://developer.android.com/google/play/billing/promo) | **Today:** Unavailable in Quotum<br>**Potential:** Unavailable through current provider APIs. Stripe has hosted promotion codes, not native app-store offer-code redemption.<br>Reviewed 2026-10-22 · [Coupons and promotion codes](https://docs.stripe.com/billing/subscriptions/coupons) | **Today:** Unavailable in Quotum<br>**Potential:** Unavailable through current provider APIs. Paddle checkout discount codes are not native app-store offer codes.<br>Reviewed 2026-10-22 · [Paddle discounts](https://developer.paddle.com/api-reference/discounts/create-discount) |

Billing intervals a plan can bind to, as `unit × count`; a quarter is three months and a half-year six:

- **Apple**: week × 1, month × 1–3, month × 6, year × 1
- **Google**: week × 1, week × 4, month × 1–4, month × 6, month × 8, year × 1
- **Stripe**: day × 1–1095, week × 1–156, month × 1–36, year × 1–3
- **Paddle**: day × 1–1095, week × 1–156, month × 1–36, year × 1–3

Today: Supported and Conditional describe implemented scope; Not implemented includes planned or blocked work; Unavailable in Quotum describes a current rejection; Not assessed in Quotum makes no implementation claim. Provider-managed means an external flow, with mirroring stated separately. Conditions, verification notes and sandbox restrictions remain explicit.

Potential:

- **Possible**: documented provider primitives can implement the operation, natively or through Quotum composition.
- **Conditional**: a candidate exists, with the stated eligibility, policy, client-flow or semantic prerequisites still applying.
- **Provider-managed only**: the provider offers an external customer flow; it does not expose the defined Quotum command.
- **Unavailable through current provider APIs**: the assessed APIs do not expose the operation's required semantics; this is not a prediction about future provider releases.
- **Unknown**: evidence does not establish semantic parity. A related feature alone is insufficient.

Declaration status rules (retained in the contract; Unsupported describes Quotum's current declaration, not future provider feasibility):

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

Planned providers, planned statuses and feasibility assessments are not commitments. Public provider sources and their review dates appear in each cell. Tests verify current implementation scope, not future feasibility or a production deployment.
<!-- provider-capabilities:end -->

## Apple StoreKit

- `apple.bundleId`, `apple.appAppleId` (numeric app id, required in production).
- `apple.issuerId`, `apple.keyId`, and the write-only `apple.privateKey` from the App Store Connect
  In-App Purchase key. Validation requires an EC P-256 private key.

Connection setup derives `apple.environment` from the selected environment, enforces online checks
in both modes, and uses the committed public Apple PKI roots in `src/providers/apple/certs/`.
Verified notifications retain Apple's `signedDate`, which connection setup uses to check that a
signed test event is no more than five minutes old.
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

Purchase verification and RTDN delivery skip consumption when Google's fetched product state is
`CONSUMPTION_STATE_CONSUMED`. A retry still records the purchase idempotently and returns its
entitlement snapshot, including when a previous consume succeeded but its response was lost.

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
- `stripe.taxMode`: `disabled`, `test`, or `registered`. `test` and `registered` turn on
  automatic tax and business tax ID collection in Checkout, which saves the billing address and
  the business name the customer enters onto the Stripe customer.
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
   one `productKey` or `planKey`, licensed `quantities` for a plan (at most 2,147,483,647 each,
   see [licensed quantities](subscriptions.md#licensed-quantities)), optional `email`, redirect
   overrides, an optional `expiresAt` (Unix seconds, within Stripe's 30-minute to 24-hour window),
   an optional `uiMode` (below) and an `Idempotency-Key`. The response is
   `{sessionId,url,duplicate}`.
2. The frontend redirects the user to Stripe.
3. Stripe posts signed events to the connection's webhook route (below); Quotum verifies
   `stripe-signature`, records paid subscription or credit-pack state, and enqueues projection sync.
4. Success pages may poll `GET .../providers/stripe/checkout-sessions/:sessionId`, which returns
   `{sessionId,status,paymentStatus,customerEmail,productKey,clientSecret}`; email and product key
   appear only once paid, `clientSecret` only while an embedded session is `open` (otherwise
   `null`), and the endpoint never grants access. `POST .../checkout-sessions/:sessionId/expire`
   expires open sessions and answers the same shape, with `clientSecret: null`. A session id Stripe does not know answers `404 NOT_FOUND` on both, and a
   session that belongs to another billing account answers
   `403 STRIPE_CHECKOUT_SESSION_ACCOUNT_MISMATCH`.

Embedded Checkout keeps the customer on the merchant's page. `uiMode` is `hosted` by default;
`uiMode: "embedded"` creates the session with Stripe's `ui_mode: embedded_page` and answers
`{sessionId,clientSecret,duplicate}` with no `url`. The frontend mounts Stripe.js Embedded Checkout
with that `clientSecret`. Stripe returns the customer to the success URL (`successUrl` or the
connection's default, which must contain `{CHECKOUT_SESSION_ID}`) as the session's `return_url`, so
the success-page polling and webhook steps above are unchanged. An embedded request takes no
`cancelUrl` (`400 INVALID_REQUEST`). Customer, line items, metadata, discounts, automatic tax, trial
settings and `expiresAt` are sent exactly as for a hosted session, and the completion webhook is the
same.

Quotum never stores or logs the client secret. The idempotency receipt records the session id with
no URL, and a replay of the same `Idempotency-Key` reads the session from Stripe and answers its
current `clientSecret` with `duplicate: true`, whatever the session's status, as a hosted replay
answers its stored URL. A session Stripe answers without a client secret is
`502 STRIPE_CHECKOUT_CLIENT_SECRET_MISSING`. A backend that kept only the session id, for example
after previewing again, reads the secret from the status route above, which answers it from Stripe
on each call while the session is still open. `uiMode` joins the idempotency hash only when it is
`embedded`, so a hosted request keeps its hash, and reusing a key across the two modes is
`409 IDEMPOTENCY_CONFLICT`. The `checkout_plan` and `checkout_product` commercial intents take the
same `uiMode` ([subscriptions](subscriptions.md#embedded-checkout)). Paddle has no embedded mode and
refuses it.

A plan with no published Stripe price, such as a free plan or one sold only through an app store,
cannot be bought or switched to through Stripe: `checkout-sessions`, the `checkout_plan`,
`setup_payment` and `subscription_change` previews and a direct plan change answer
`409 PLAN_NOT_PURCHASABLE_VIA_STRIPE` naming the plan. A consumable or non-consumable Stripe product
stored without a price amount and currency answers `409 PRODUCT_NOT_PURCHASABLE_VIA_STRIPE`. Fix the
catalog or the Stripe mapping; the request is not retried. A [gift](catalog.md#gifts) product
answers the same code while its gift is not on sale: it has no published gift, the gift was
retired, or its promotion no longer gives a plan.

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

A subscription Stripe ended, by an immediate cancellation or when its period closed, expires when
Stripe ended it, and its recorded expiry moves to that moment even though the period was paid
through later. A cancellation that shares a second with the subscription's earlier event applies,
and so does a reconciliation read that finds the subscription ended; see
[event order](subscriptions.md#which-plan-version-a-stripe-update-applies).

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

A refund of a subscription's payment, made in Stripe or
[through Quotum](subscriptions.md#refunding-a-payment), returns the money and takes back the
refunded share of the credits that payment funded. Stripe leaves the subscription running, and so does Quotum: the
subscription's own state and its access entitlements stay until it ends. To end access with the
refund, cancel the subscription as well, in Stripe or with an immediate
[cancellation](subscriptions.md#cancelling-and-uncancelling-a-subscription).

Quotum adds the refund to the invoice's cumulative reversed amount, capped at what was paid, and
scales the plan allocations of the service period the invoice's advance-billed lines cover to that
share of the payment. Usage billed in arrears and proration lines name periods other invoices paid
for, so they never select the allocations. A reversal never goes below what an allocation already
reversed and never into quantity that is consumed or held, so spent credit stays spent and open
reservations still settle. A refund of the whole payment closes the allocation. A dispute reverses
nothing: a won dispute has no event that would restore the credits. A refund in another currency
than the invoice's, or of an invoice whose stored payload no longer names its period, is recorded
and reported without changing a balance.

Quotum still records the event and tells your backend. Neither the refund nor its payment names an
invoice, so Quotum asks Stripe which invoice the payment settled, through Stripe's invoice payments
list filtered by the payment intent, and matches it to a subscription invoice recorded from
`invoice.paid`. The store event is then
`processed` against that subscription, and one projection per refund or dispute carries a
`reversal` fact with `creditAmount: 0`, because a subscription funds several features, the refund or
dispute id as `transactionId`, the payment intent as `originalTransactionId` and the subscription's
`productKey`, next to the [`subscription` fact](#projections). The balances after a refund arrive in
the usage delivery that follows it. A `reversal` that arrives with a `subscription` fact is a
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

### Events that contradict a stored identity

A signed Stripe event whose identities disagree with what Quotum stored is acknowledged, not
refused. The webhook answers `200` with `status: "skipped"`, so Stripe stops redelivering a body
that no retry can apply. Quotum never reassigns a link to make an event fit: the event's recording
rolls back as a whole, so no account, customer link, purchase, subscription, balance or delivery
comes from it, and the event is stored as `skipped` with a `processingError` of
`<reason>: <detail>`, where the detail names Stripe object ids only. A warning log carries the
event id, its type and the reason when the event arrives through the webhook route or a replay. An
event from the Stripe App event inbox is stored the same way and its inbox entry is marked
processed, without a log line of its own.

| Reason | Meaning |
| --- | --- |
| `stripe_customer_linked_to_other_account` | The Stripe customer the event names is linked to a billing account other than the one the event resolves to, for example a Checkout whose `billingAccountId` metadata names another account. |
| `stripe_account_linked_to_other_customer` | The billing account is already linked to a different Stripe customer; an account has one Stripe customer. |
| `stripe_purchase_identity_conflict` | The payment is already recorded for another customer or product. |
| `stripe_subscription_identity_conflict` | The subscription the event describes, or the one its invoice belongs to, is already recorded for another customer or product. |
| `stripe_event_identity_changed` | The event id was already recorded with another customer, product, payment or event type. |

The first four events are retried by the event replay worker with backoff, and each retry stores
the reason as `processingError`. An event that is never fixed ends `failed` after
`BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS` attempts and nothing it carried is applied. Quotum never
changes a link on its own. For the two link conflicts an operator can
[unlink the Stripe customer](#unlinking-a-stripe-customer); the next retry, or
`POST /v1/admin/store-events/:eventId/replay`, then applies the event from its stored payload. A
purchase or subscription conflict has no such repair. Settle that payment in Stripe: refund it, or
take it again through a Quotum checkout for the intended billing account, which uses that account's
own Stripe customer.

A `stripe_event_identity_changed` delivery keeps the original event untouched: its stored row stays
`processed` with the identities it was applied under, and the changed delivery is only logged,
because recording it would overwrite the first. A provider read made by subscription
reconciliation has no event id and is never redelivered, so a conflict there still fails the job
with the same message and the worker retries it with backoff.

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

### Unlinking a Stripe customer

A billing account has one Stripe customer, and the link is written once: by the first Quotum
checkout, portal session or payment setup for the account, or by the first verified event that
names both. An operator can remove it when it no longer fits. That is the repair for the two link
conflicts above, and for an account whose Stripe customer was deleted in Stripe.

```http
POST /v1/admin/provider-customer-unlinks/:billingAccountId
GET  /v1/admin/provider-customer-unlinks/:billingAccountId
```

Both need the operator key, so a read-only credential is refused. The `POST` also needs
`X-Billing-Actor` and an `Idempotency-Key`, and its body names the link to remove:

```json
{ "provider": "stripe", "externalCustomerId": "cus_123", "reason": "Stripe customer was deleted" }
```

`provider` accepts only `stripe`, and `reason` is 1-500 characters. `externalCustomerId` must be
the customer the account is linked to now, so a link that changed since the operator looked is not
removed. `GET /v1/admin/customers/by-billing-account/:billingAccountId` shows the current link
under `providerCustomers`.

| Answer | When |
| --- | --- |
| `201` with the receipt | The link was removed. |
| `200` with `duplicate: true` | The same `Idempotency-Key` was replayed with the same body. |
| `404 BILLING_ACCOUNT_NOT_FOUND` | The account does not exist. It is not created. |
| `404 PROVIDER_CUSTOMER_LINK_NOT_FOUND` | The account has no Stripe customer. |
| `409 PROVIDER_CUSTOMER_LINK_MISMATCH` | The account is linked to another customer, named in `details.externalCustomerId`. |
| `409 PROVIDER_CUSTOMER_LINK_IN_USE` | Work listed below is still open; `details.blockers` gives each `kind` and its `count`. |
| `409 IDEMPOTENCY_CONFLICT` | The `Idempotency-Key` was used for this account with another body. |

The unlink removes the link and nothing else. Purchases, subscriptions, balances and entitlements
recorded for the account stay, and no projection is sent. It never points the account at another
customer: the next event or checkout for the account writes the link under the same checks as a
first one. The receipt keeps the removed customer id, its Stripe account, when the link was
written, the actor and the reason, and is never changed; the `GET` lists an account's receipts
newest first (`limit` up to 100, default 25, and `cursor`).

The link decides which Stripe customer the account's work charges and reports through, so the
unlink is refused while any of this work is open:

| Blocker `kind` | What holds the link |
| --- | --- |
| `subscription` | A Stripe subscription in `active`, `grace_period` or `billing_retry`. One that Stripe has ended (`cancelled`, `expired`) does not hold it, even with paid time left. |
| `provider_operation` | A Stripe provider operation in `prepared`, `in_flight`, `reconciling` or `requires_review`. |
| `payment_setup` | A hosted payment setup that is neither `completed` nor `expired`. |
| `auto_topup_job` | An automatic top-up job in `pending` or `processing`. |
| `usage_invoice` | A usage invoice period or adjustment in `pending` or `processing`. One that ended `failed` does not hold it. |

An automatic top-up policy does not hold the link and stays in place. A top-up that comes due while
the account has no Stripe customer ends `provider_action_required`, and later ones charge the
customer the account is linked to by then.

After the unlink:

- A skipped or failed event for the account applies on the replay worker's next retry, or on
  `POST /v1/admin/store-events/:eventId/replay`.
- The next Quotum checkout, portal session or payment setup creates a new Stripe customer for the
  account. Stripe answers a repeated customer creation with the first result for 24 hours, so the
  creation request carries the account's unlink count and Stripe treats it as a new request. An
  account that was never unlinked sends the request it always sent.
- A later Stripe event that names the removed customer is handled like any other: a purchase or
  subscription it carries links the customer, under the rules above, to the account the event
  resolves to.

An account whose Stripe customer was deleted shows up as failing checkouts. Stripe refuses the
stored customer id, the request answers `500 INTERNAL_ERROR`, and the log carries Stripe's
`No such customer` error; nothing changes the link on its own. Deleting a customer in Stripe also
cancels its subscriptions. Once those events are recorded, unlink the customer and the next
checkout starts a new one.

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
3. **Verify events (production only).** Before enabling a live provider, point its webhook at the
   setup path and send an event that exists in that account and is at most five minutes old. For
   Stripe, produce a real event, such as editing product metadata with `product.updated` selected
   on the endpoint. Commit with `--wait-for-event 10m` to wait for it. A refused event answers `400`
   with a `reason`; see [If a setup event is refused](#if-a-setup-event-is-refused). Sandbox commits
   without this production event requirement.
4. **Commit.** `quotum connections commit <instance> <kind> <draft-id>` validates again and enables
   the version. Point the provider's webhook at `/v1/projects/<instance>/webhooks/<provider>`.
5. **Issue a key when needed.** Both environments are already active. Run `quotum credentials
   rotate <instance> --credentials-out <new-file>` independently of connection/catalog setup.
   `quotum environments readiness <instance>` reports informational findings only. A live provider
   saved by an older release without event verification remains unavailable for new provider work
   until verified; recovery and webhook processing continue.

These commands, and `quotum credentials` and `quotum environments`, read `QUOTUM_AUTH_SECRET` even
in headless mode. It keys their request fingerprints the way it does for the merchant platform.
While the merchant platform runs, an organization that has members manages its own connections:
`quotum connections list` and `quotum credentials status` still read it, and any change needs
`--member-override-reason <why>`,
which the audit event records next to the operator. Stripe App OAuth needs a merchant session, so it
is available only in the merchant application.

### If a setup event is refused

The setup route answers `404` for an unknown project, a provider that does not match the saved
connection, or a version that expired or was retired, and `413` for a body over 256 KB. For an
event it refused after finding the saved version it answers `400 {"success": false}` with a
`reason` that never contains a key, a secret or the provider's own text. Stripe's webhook delivery
log shows this body, and the service logs a warning with the same reason, the version and, for
Stripe, the request id Stripe gave the failed call.

| `reason` | Meaning |
| --- | --- |
| `signature_invalid` | The signature or its timestamp does not verify with the saved webhook secret, which is often the secret of another endpoint |
| `verification_failed` | An Apple or Google notification did not verify for this connection |
| `mode_mismatch` | A live event reached a sandbox draft, or a test event a production one |
| `account_mismatch` | The event belongs to another Stripe account than the key's |
| `missing_permission` | Stripe answered 403; `missingPermission` is `event_read` (Events: Read) or `connected_account_read` (Accounts: Read) |
| `authentication_failed` | Stripe rejected the saved key |
| `event_not_found` | Stripe has no event with that id for this key: it comes from another account, it is not a real event of this account, or it is older than 30 days |
| `event_mismatch` | Stripe returned a different event than the one signed |
| `stale_event` | The event is more than five minutes old; resending it does not help, so produce a new one |
| `connection_changed` | The event predates this draft, or the draft expired or was replaced |
| `provider_unavailable` | The provider call failed for another reason; send the event again |

A `400` without a `reason` means the version was not found, or its saved secrets or settings could
not be read.

## Projections

Projections carry an account's state to one product receiver. To send selected billing events to
endpoints of your choice, use [outbound webhooks](webhooks.md).

Quotum never writes your database. It delivers signed HTTP `billing_state_v1` projections with
the entitlement and exact-string balance snapshot to the connection's projection URL, retrying
with backoff. Verify `X-Billing-Signature` and `X-Billing-Timestamp`, and treat the projection as a
read model: authorization decisions must use the metering API. Order snapshots per billing account
by `sequence`, and record `purchase`, `reversal`, `trial` and `planGrant` facts idempotently by
their key.
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
  `reversal`, `trial`, `planGrant` and `subscription` facts with the rules between them.
- [`contracts/v1/projection-delivery.examples.json`](../contracts/v1/projection-delivery.examples.json)
  holds one example per case, each with a `description` and the `delivery` body: a Stripe
  subscription's purchase, renewal, refunded payment, scheduled cancellation and end, a trial's
  start and its ending notice, a one-time purchase with its refund, a verified App Store
  subscription, a verified Google Play subscription and consumable, a promotional plan grant's
  ending notice and its end, and a usage snapshot with a balance. The integration lane compares each with
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

A [gift](catalog.md#gifts) purchase is a `purchase` fact like a top-up's, with `purchaseKind:
"consumable"` and `creditAmount: 0`; tell it from a top-up by its `productKey`. It grants the
buyer nothing, so a receiver deriving access from facts reads no entitlement from it, and its
refund or dispute is a `reversal` fact with `creditAmount: 0`. The codes are not in the fact: read
them through [Gift codes](promotions.md#gift-codes).

A payload carries at most one of the facts `purchase`, `reversal`, `trial` and `planGrant`. A `reversal` with
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

The plan a [redeemed promotion code](grants.md#promotional-plan-grants) gives is a plan grant too,
but it is not a trial and reports through its own `planGrant` fact. Its entitlements carry
`source: "plan_grant"`, `origin: "promotion"`, `status`, `planKey`, `planGrantId` and
`promotionRedemptionId`. The fact carries `event`, `origin: "promotion"`, `planGrantId`, `planKey`,
`promotionRedemptionId`, `startsAt` and `endsAt`:

- `event: "ending"` arrives once per grant, about three days before its end (reason
  `expiry_reconciliation`, key `plan_grant_ending:<id>:<endsAt>`). A grant redeemed that close to
  its end is announced at the next worker pass.
- `event: "ended"` arrives when the grant expires (reason `expiry_reconciliation`, key
  `expiry_reconciliation:plan_grant:<id>:<endsAt>`) or its redemption is revoked (a stored
  `usage_changed` keyed `plan_grant:<id>:ended`, whose `endsAt` is the moment the grant ended).

A grant that a paid base subscription supersedes sends no fact, since the customer converted.

Each balance reports `periodEndsAt`, the end of its earliest allowance or meter-limit window. A
plan grant's allowance (a trial's, a promotional grant's or the default plan's) resets without a
delivery, as a meter-limit
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
discard the snapshot but should still record any `purchase`, `reversal`, `trial` or `planGrant` facts by their key. The
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
  with either of them while the merchant platform is on (`QUOTUM_CONSOLE_ENABLED=true`), because
  merchants' receivers must stay on public HTTPS.

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
   migrations and their Drizzle `check()` mirrors match the admitted providers, and
   `tests/integration/schema-parity.test.ts` compares every mirrored CHECK definition with the
   migrated database; checkout requests admit only providers that implement checkout.
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
| Charges and Refunds | Write (`refund_write`, optional) | Refund a payment when a caller asks Quotum to; a key without it still validates |
| Events | Read (`event_read`) | Retrieve the signed setup event with the connection's own key before enabling a production connection |

Validation runs bounded probes and reports all detected failures in `error.details.checks`
with `check`, `reason`, and, where relevant, `missingPermission` and `httpStatus`.
`missingPermissions` deduplicates detected missing permissions. This recipe covers the manual
billing adapter; the Stripe App manifest has additional installation/event permissions.

Events: Read is probed (a list of one event through Stripe's events API) only for a production
environment's restricted key, the one connection that must verify a signed setup event before it is
activated (see [headless connection setup](#headless-connection-setup)). A sandbox connection never
waits for one, and a Stripe App install has its events delivered through the app, so neither needs
the permission. Without it the setup event cannot be retrieved and activation stalls on
`STRIPE_EVENT_REQUIRED`. Payment Disputes: Read is not needed.

A successful read does not prove write access, so each of the seven write permissions
(`customer_write`, `checkout_session_write`, `customer_portal_write`, `subscription_write`,
`invoice_write`, `coupon_write`, `promotion_code_write`) gets a probe of its own: a write that
cannot succeed. Stripe checks a key's permission before it looks at the request, so it answers 403
naming the permission when the key lacks it, and 404 or 400 when the key has it. Quotum updates a
customer, subscription and invoice id that cannot exist, and creates a Checkout Session, portal
session, coupon and promotion code with a missing or invalid required parameter. Validation never
creates or changes a Stripe object, but your Stripe request log shows these seven requests as
failed on every validation.

A 403 fails validation like a missing read permission. A verified permission appears in `checks`
as passed. A probe that proves nothing, for a rate limit or an outage, leaves its permission in
`unverifiedPermissions`: check those in the Dashboard. Stripe does not document the order of its
permission and request checks, so `BILLING_STRIPE_WRITE_PERMISSION_PROBES=false` turns the write
probes off; `unverifiedPermissions` then lists every write permission, as it did before the probes
existed.

`refund_write` is probed the same way (a refund of a payment that cannot exist) but is optional: a
merchant that never refunds through Quotum is not asked for it. A key that lacks it validates, and
`unverifiedPermissions` lists `refund_write` until the permission is added. It is the Charges and
Refunds resource set to Write, the name Stripe's own restricted-key and Stripe App permission lists
use for the resource (`charge_write` in an app manifest).

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
`QUOTUM_CONSOLE_ENABLED=false`. The reference receiver implements the same handshake.
