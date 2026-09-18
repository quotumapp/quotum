# API guide

- Document kind: Current behavior

The complete HTTP surface is published as [`contracts/v1/openapi.json`](../contracts/v1/openapi.json)
with the runtime error inventory in [`contracts/v1/errors.json`](../contracts/v1/errors.json). Billing JSON operations use the envelope `{"success":true,"data":...}` or
`{"success":false,"error":{"code":...,"message":...}}`. An error may also carry an optional
`details` object with structured context for its code (see
[Provider capability errors](#provider-capability-errors)); the key is absent when there is none.
Error codes are extensible, so handle unknown codes and ignore `details` keys you do not recognize.
Health/metrics and authentication/provider callback surfaces have their own response shapes;
consult the generated contract rather than applying the billing envelope to every route.

Regenerate and validate after changing a route:

```sh
bun run openapi:generate
bun run openapi:check
bun run openapi:lint
```

Generation uses module-owned Zod schemas and needs no database or credentials. CI diffs the contract
against the base revision; compatible patch releases must not introduce breaking changes.

## Metering

Trusted backends authorize work through these routes:

```http
GET    /v1/billing-accounts/:billingAccountId/balances/:featureKey
GET    /v1/billing-accounts/:billingAccountId/billing-summary
GET    /v1/billing-accounts/:billingAccountId/usage/events
GET    /v1/billing-accounts/:billingAccountId/usage/series
POST   /v1/billing-accounts/:billingAccountId/usage/check
POST   /v1/billing-accounts/:billingAccountId/usage/consume
POST   /v1/billing-accounts/:billingAccountId/usage/reservations
POST   /v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/confirm
POST   /v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/release
POST   /v1/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections
POST   /v1/billing-accounts/:billingAccountId/entities
GET    /v1/billing-accounts/:billingAccountId/entities
PUT    /v1/billing-accounts/:billingAccountId/controls
GET    /v1/billing-accounts/:billingAccountId/controls
POST   /v1/billing-accounts/:billingAccountId/usage-alerts
GET    /v1/billing-accounts/:billingAccountId/usage-alerts
GET    /v1/billing-accounts/:billingAccountId/usage-alert-events
PUT    /v1/billing-accounts/:billingAccountId/auto-topup
GET    /v1/billing-accounts/:billingAccountId/auto-topup?featureKey=:featureKey[&entityId=:entityId]
GET    /v1/billing-accounts/:billingAccountId/license-pools
POST   /v1/billing-accounts/:billingAccountId/license-assignments
DELETE /v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId
GET    /v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey
POST   /v1/billing-accounts/:billingAccountId/commercial-actions/preview
POST   /v1/billing-accounts/:billingAccountId/commercial-actions
GET    /v1/billing-accounts/:billingAccountId/entitlements
```

Quantities are decimal strings. A check is side-effect-free, consume records an immutable receipt,
and reservation finalization is atomic. Usage mutations require `Idempotency-Key`; corrections,
controls, alerts, automatic top-ups, and license assignments also require `X-Billing-Actor`.
Confirming more than the reserved quantity returns `RESERVATION_QUANTITY_EXCEEDED`, a changed
confirmation returns `RESERVATION_ALREADY_CONFIRMED`, and using a newly published meter absent from
the account's purchased catalog returns `METER_RATE_NOT_ACTIVATED`. Omitted `expiresInSeconds` on a
reservation defaults to 300.

Usage reads default to the last 30 days, reject ranges over 90 days, and page with an opaque cursor
(default 50, maximum 200). Series support `hour` or `day` buckets. These reads and `billing-summary`
never authorize work; product projections are display caches and cannot replace the metering calls.

Commercial preview accepts one complete Stripe intent (`checkout_plan`, `checkout_product`, or
`subscription_change`) and returns exact or provider-calculated amounts valid for 15 minutes.
Execution accepts only the `previewToken` with an `Idempotency-Key` and rejects expired previews,
catalog or customer drift, or a changed target. A Checkout result is HTTP 200; a durable
subscription-change result is HTTP 202.

## Usage operation recovery

Consume, reserve, confirm, release, and correction are recoverable under the caller-owned
`Idempotency-Key`, scoped to `(projectInstanceId, billingAccountId, operation kind, key)`. After a
timeout, lost response, `5xx`, or restart, retry with the same key and input: same-input replay
returns the original result, including a denial; different input returns `409 IDEMPOTENCY_CONFLICT`.
Keep `occurredAt` and semantic metadata stable across retries and put per-attempt tracing in headers.

```http
GET /v1/billing-accounts/:billingAccountId/usage/operations/:operation/:operationId
```

returns `operation`, `operationId`, `status`, `completedAt`, and a compact `outcome`. The SDK exposes
it as `client.usage.getOperation`.

- `409 OPERATION_IN_PROGRESS`: another transaction owns the operation; retry the same input.
- `409 OPERATION_RESULT_EXPIRED`: the identity is retained but its result is gone; do not mint a new
  key to repeat the charge.
- `404 OPERATION_NOT_FOUND`: no retained identity; after an uncertain request retry only the original
  key.

Outcomes are retained for at least 24 hours and identities for at least seven days. Stored outcomes
are limited to 64 KiB; `500 OPERATION_OUTCOME_TOO_LARGE` rolls back the whole mutation, and accounts
with very large allocation breakdowns need investigation rather than retries.

## Catalog publication

Operators submit one complete intent to `POST /v1/admin/catalog/preview` and then
`POST /v1/admin/catalog/publish` with the preview token and expected revision; both require project
and operator authentication plus `X-Billing-Actor`. Provider bindings adopt pre-provisioned store
products and must all be ready before the active pointer advances. Previously active features,
plans, and top-ups must be retained or listed explicitly for retirement; omission is not deletion.
Retiring a plan removes it from new selection without rewriting pinned subscriptions.
`GET /v1/admin/catalog` returns the active intent. See
[`examples/quickstart/catalog.json`](../examples/quickstart/catalog.json) for a minimal intent.

Preview and publish validate the intent's structure first and reject the first structural problem,
including a binding on the wrong channel, with `400 INVALID_REQUEST`. Only then do they check each
provider binding against its provider's capability declaration: a plan with a trial, an add-on
plan, every explicit price component (`basePrice` or an item `price`), and every top-up need the
matching `catalog.*` operations (a top-up needs `catalog.topup`). All incompatible bindings are
reported together as one `400 PROVIDER_CAPABILITY_UNSUPPORTED` whose
`details.providerCompatibility` lists them in catalog order; see
[Provider capability errors](#provider-capability-errors). The whole submitted intent is checked,
including the plans it keeps unchanged. The published catalog is never re-validated against the
declarations: it stays readable, and preview still compares a new intent against it.

The same contract is available as code:

```sh
export BILLING_BASE_URL=https://billing.example.com
export BILLING_PROJECT_API_KEY=...
export BILLING_OPERATOR_API_KEY=...
export BILLING_ACTOR=deploy@example.com

bun run catalog status
bun run catalog diff ./billing.catalog.ts
bun run catalog push ./billing.catalog.ts
```

The backend SDK (`quotum-api/sdk`) wraps catalog, commercial, usage, and selected admin calls and
keeps credentials server-side.

## Provider capability errors

Each provider declares which operations it supports and under which conditions; see
[Provider capabilities](providers.md#provider-capabilities). A request that a declaration rules out
fails before Quotum calls the provider, with a code chosen by the layer that blocked it:

| Code | Status | Blocking layer | `details` |
| --- | --- | --- | --- |
| `PROVIDER_CAPABILITY_UNSUPPORTED` | 400 | `provider`: the provider does not offer the operation or manages it itself. `implementation`: Quotum does not implement it for that provider. | `providerCompatibility` from catalog preview and publish, otherwise `verdict` |
| `PROVIDER_CAPABILITY_NOT_CONFIGURED` | 409 | `configuration`: the project's provider connection lacks a setting the operation needs. | `verdict` |
| `PROVIDER_ACTION_REQUIRED` | 409 | `operation`: the request does not meet one of the operation's conditions. | `verdict` |

Catalog preview and publish are the only routes that return a capability error today, always as
`PROVIDER_CAPABILITY_UNSUPPORTED`. The two `409` codes are in the error inventory, but no route
returns them yet.

- `details.verdict` is one capability verdict: `provider`, `operation`, `outcome`, `level`,
  `blockingLayer`, and ordered `reasons`. Each reason has its own `code`, `layer`, `observed`
  values, and a `resolution`. Reason codes such as `PROVIDER_MANAGED` explain the verdict; they
  are not error codes.
- `details.providerCompatibility` lists every incompatible binding in catalog order: per plan, the
  plan itself when it has a trial or is an add-on, then its base price and item prices; then
  top-ups. An entry names its `target` (`kind` `plan`, `price` or `topup`, the plan or top-up
  `key`, and `priceKey` for a price), the binding's `provider`, `channel` and `productKey`, the
  `requiredOperations`, `compatible: false`, and the blocked `verdicts`. The message names the
  first entry and counts the others, as in `Plan pro cannot bind apple: catalog.trial is not
  supported (and 2 more)`.

The named schemas `RuntimeCapabilityVerdict` and `CatalogProviderCompatibility` in the OpenAPI
contract describe these objects; the envelope itself types `details` as an open object. A plan
with a 14-day trial bound to Apple and Stripe is rejected with:

```json
{
  "success": false,
  "error": {
    "code": "PROVIDER_CAPABILITY_UNSUPPORTED",
    "message": "Plan pro cannot bind apple: catalog.trial is not supported",
    "details": {
      "providerCompatibility": [
        {
          "target": { "kind": "plan", "key": "pro" },
          "provider": "apple",
          "channel": "ios",
          "productKey": "pro_monthly",
          "requiredOperations": ["catalog.trial"],
          "compatible": false,
          "verdicts": [
            {
              "provider": "apple",
              "operation": "catalog.trial",
              "outcome": "blocked",
              "level": "provider_managed",
              "blockingLayer": "provider",
              "reasons": [
                {
                  "code": "PROVIDER_MANAGED",
                  "layer": "provider",
                  "observed": { "level": "provider_managed" },
                  "resolution": { "kind": "none" }
                }
              ]
            }
          ]
        }
      ]
    }
  }
}
```

A Stripe-backed route whose Stripe service lacks the method it needs returns
`503 BILLING_PROVIDER_NOT_CONFIGURED` with `details` `{"provider":"stripe","adapterMethod":...}`:

| Route | `adapterMethod` |
| --- | --- |
| `GET /v1/catalog` | `reads.catalog` |
| `GET /v1/billing-accounts/:billingAccountId/billing-account` | `reads.billingAccount` |
| `POST /v1/billing-accounts/:billingAccountId/commercial-actions/preview` | `commercial.preview` |
| `POST /v1/billing-accounts/:billingAccountId/commercial-actions` | `commercial.execute` |
| `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions` with a `planKey` | `checkout.createPlan` |
| `POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes` | `commercial.requestChange` |
| `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId/expire` | `checkout.expire` |

The merchant billing proxy returns the same code and `details` for its billing-account,
commercial preview and commercial action operations. On `/v1`, commercial execution and
subscription changes reject a missing `Idempotency-Key` with `400` before this check. When the
provider has no connection at all, `BILLING_PROVIDER_NOT_CONFIGURED` carries no `details` (`503`
for Stripe, `501` for Apple and Google). `503 STRIPE_NOT_CONFIGURED` is narrower: only the Stripe
service returns it, when its Stripe client or billing storage lacks a dependency of subscription
changes, commercial actions, checkout expiry, or recurring pricing.

## Promotions

A promotion is an immutable offer with one effect: a `discount` (percent in basis points, or a
fixed amount per currency, lasting `once`, `repeating` for 1-36 months, or `forever`), a
`feature_grant` of consumable feature quantities, or a `plan_grant` of a plan for a number of days
or months. It can target plan or product keys and restrict the channels (`web`, `ios`, `android`)
where a code may be entered. Changing terms means creating a new promotion.

Operators manage promotions with project authentication, `X-Billing-Operator-Key`, and
`X-Billing-Actor` on mutations:

- `POST /v1/admin/promotions` creates a promotion and optional codes. It returns `201`, or `200`
  when the same key is replayed with identical terms; different terms return
  `PROMOTION_KEY_CONFLICT`.
- `GET /v1/admin/promotions` and `GET /v1/admin/promotions/:promotionKey` list and read promotions
  with code and redemption counts.
- `POST /v1/admin/promotions/:promotionKey/codes` adds codes all-or-nothing;
  `GET .../codes` lists them; `POST .../codes/:codeId/deactivate` deactivates one.
- `POST /v1/admin/promotions/:promotionKey/archive` stops new redemptions.
- `GET /v1/admin/promotions/:promotionKey/redemptions` lists the redemption ledger.

Codes use 3-64 letters, digits, or hyphens and are unique per project instance regardless of
case. Each code can set a start and expiry, a global cap, a per-customer cap (one by default,
`null` for unlimited), a first-purchase-only rule, and a billing-account restriction. A code marked
`hostedCheckoutEnabled` cannot carry a per-customer cap or an account restriction.

`POST /v1/billing-accounts/:billingAccountId/promotion-codes/validate` lets the trusted backend
check a code before offering it. It needs only project authentication, never creates a customer
or takes a use, and returns `200` with `valid` and a `reason` such as `PROMOTION_CODE_EXPIRED`,
`PROMOTION_CODE_EXHAUSTED`, `PROMOTION_CODE_ALREADY_REDEEMED`, or
`PROMOTION_CODE_NOT_APPLICABLE` for a `target` the promotion does not cover. Unknown codes and codes
restricted to another account both report `PROMOTION_CODE_NOT_FOUND` without promotion details.
It is rate limited per project with the purchase-verification limit
(`BILLING_VERIFY_RATE_LIMIT_PER_WINDOW`), counted separately from verification.

Checkout intents (`checkout_plan`, `checkout_product`) accept one discount entry mode:

- `promotionCode`: the backend applies a code it collected. Preview runs the same checks as
  validation and returns `subtotalMinor`, `discountTotalMinor`, the discounted
  `estimatedTotalMinor`, per-line `subtotalMinor`/`discountMinor`/`totalMinor`, the `promotion`
  terms, and for recurring plans a `nextCycle` whose `discountStatus` is `applies` or `ended`.
  Tiered lines stay `provider_calculated`. Execution reserves one use of the code, passes the
  promotion's Stripe coupon to Checkout, and returns `promotionRedemption`; the completed Checkout
  webhook applies the use, and an expired or failed session releases it. A fully refunded purchase
  marks its redemption `reversed` but keeps the use counted.
- `allowPromotionCodes: true`: Stripe shows its own code field. Only codes marked
  `hostedCheckoutEnabled` exist in Stripe; Quotum records their use from the completed Checkout
  webhook, including uses past a cap that Stripe accepted.

Sending both returns `PROMOTION_CODE_ENTRY_CONFLICT`. A promotion without a Stripe coupon yet is
created during execution; if Stripe rejected it, execution returns `PROMOTION_PROVIDER_NOT_READY`.

`subscription_change` intents accept `promotionCode` for the target plan. Proration stays
`provider_calculated`; `nextCycle` shows the discounted renewal, or `provider_calculated` for a
`once` discount. A subscription with a Quotum discount that can still apply rejects another code
with `PROMOTION_STACKING_NOT_ALLOWED`. Execution reserves the use with the queued change. The worker
adds the coupon to the subscription while keeping its existing discounts, applies the use when the
change applies, and releases it when the change fails for good. Metered overage invoices and
automatic top-ups are billed at list price.

`POST /v1/billing-accounts/:billingAccountId/promotion-redemptions` redeems a code outside a
purchase. It needs project authentication, an `Idempotency-Key`, and a body with `code` and the
`channel` where the customer entered it; `X-Billing-Actor` is optional and defaults to the billing
account. A `feature_grant` code takes one use and returns `kind: "granted"` with one reward
allocation per feature. Rewards expire `expiresAfterSeconds` after redemption, are spent like any
other allocation, and trigger a coalesced `usage_changed` projection. A `discount` code takes no use
and returns `kind: "requires_commercial_action"`; pass it as `promotionCode` to a commercial action.
Codes cannot be redeemed on `ios`, because App Store rules bar unlocking digital content with
developer codes (`PROMOTION_CODE_CHANNEL_NOT_SUPPORTED`). Replaying the key returns the stored
result with `duplicate: true`, and reusing it for a different code or channel returns
`IDEMPOTENCY_CONFLICT`. Redemption shares the validation rate limit.
`GET .../promotion-redemptions` and `GET .../promotion-redemptions/:redemptionId` read one
account's ledger.

`POST /v1/admin/promotion-redemptions/:redemptionId/revoke` takes back a Quotum grant. It needs the
operator key, `X-Billing-Actor`, an `Idempotency-Key`, and a `reason`. Every unexpired reward
allocation stops counting; what was already consumed stays consumed, and the response reports the
reversed, consumed, and held quantity per allocation. The use stays counted against the code's
limits. Only applied `quotum` redemptions can be revoked (`PROMOTION_REDEMPTION_NOT_REVOCABLE`);
refund Stripe purchases instead. A second revocation with another key returns
`PROMOTION_REDEMPTION_ALREADY_REVERSED`.

## Admin operations

Every admin route requires project authentication. The routes listed under Operator routes also
require `X-Billing-Operator-Key`, including their reads.

Reads with project authentication only:

- `GET /v1/admin/customers/search?q=...`: prefix match across account, customer, provider, and
  transaction ids; queries are capped at 128 characters.
- `GET /v1/admin/customers/by-billing-account/:billingAccountId`,
  `GET /v1/admin/customers/:customerId`, and per-customer `purchases`, `subscriptions`,
  `store-events`, and `projection-jobs`.
- `GET /v1/admin/purchases`, `/subscriptions`, `/store-events`, `/projection-jobs`.
- `GET /v1/admin/usage-events`: project-wide usage events with optional `billingAccountId`.
  Same 30-day default, 90-day cap, and cursor paging (default 50, maximum 200) as the other
  usage reads. Each row carries `customerId`, `billingAccountId`, and nullable `customerEmail`.
- `GET /v1/admin/store-events/:eventId` with optional `includeRawPayload=true` (audit-logged, secrets
  redacted).
- `GET /v1/admin/stats/summary`.

Operator routes:

- `GET /v1/admin/catalog`, `GET /v1/admin/catalog/products`,
  `GET /v1/admin/catalog/store-products`, `POST /v1/admin/catalog/preview`,
  `POST /v1/admin/catalog/publish`.
- `POST /v1/admin/contracts/preview`, `POST /v1/admin/contracts/publish`,
  `GET /v1/admin/contracts/:billingAccountId`,
  `DELETE /v1/admin/contracts/:billingAccountId/:contractId`.
- `POST /v1/admin/catalog-migrations/preview`, `POST /v1/admin/catalog-migrations/publish`.
- `POST /v1/admin/auto-topups/:billingAccountId/:policyId/reset`.
- Promotion management under `/v1/admin/promotions` and
  `POST /v1/admin/promotion-redemptions/:redemptionId/revoke`; see [Promotions](#promotions).
- `POST /v1/admin/store-events/:eventId/replay`.
- `POST /v1/admin/reconciliation/subscriptions/run`.
- `POST /v1/admin/projection-jobs/:jobId/retry`.
- `GET /v1/admin/metrics`.
