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

## Read-only credentials

A project credential is either full (`sqpk_`, `pqpk_`) or read-only (`sqrk_`, `pqrk_`). A read-only
credential is for tools that inspect billing state without authority to change it, such as the
[MCP server](mcp.md) or a support console. It reaches only the operations that carry
`x-quotum-credential-access: read_only` in the [contract](../contracts/v1/openapi.json): the reads
that write nothing and call no provider, plus `POST .../usage/check`. Everything else answers
`403 READ_ONLY_CREDENTIAL` before validation, rate limiting or any handler runs:

- every mutation, including the previews, which persist a draft or a token;
- `GET .../providers/apple/account-token` and `GET .../providers/google/account-link`, which create
  state on first read, and `GET .../providers/stripe/checkout-sessions/:sessionId`, which calls
  Stripe;
- promotion code validation and the promotion redemption reads, because codes are bearer-like;
- every operator route, and `includeRawPayload=true` on a store event.

The stored credential decides the access level; the prefix only lets a client refuse a full key
without a lookup. In [gateway mode](deployment.md#authentication) the trusted gateway states the
level with `x-billing-credential-access` instead. Both kinds share the project's rate-limit buckets. Each refusal logs a warning,
`Read-only project credential refused`, with the project instance, method and route. It is worth an
alert: a read-only key used for writes is either a misconfigured tool or a leaked key being probed.

## Metering

Meter-limit balances and capped usage remain scoped to the requested entity and canonical filter.
Monetary spend for postpaid overage is rated across every scoped window belonging to the same
subscription, purchased plan item, and billing period, exactly as the usage invoice is rated.
The included allowance and price tiers apply once to that combined quantity. Checks, consumes,
reservations, confirmations, and corrections use this shared monetary scope; selecting another
filter or entity does not create another included monetary allowance.

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
reservation defaults to 300. License pools follow the purchased subscription-item quantity: an
entity license check honors active assignments in assignment order up to that capacity, so a seat
downgrade stops authorizing the assignments beyond it until they are revoked.

Usage reads default to the last 30 days, reject ranges over 90 days, and page with an opaque cursor
(default 50, maximum 200). Series support `hour` or `day` buckets. These reads and `billing-summary`
never authorize work; product projections are display caches and cannot replace the metering calls.

Commercial preview accepts one complete Stripe intent (`checkout_plan`, `checkout_product`,
`subscription_change`, `cancel`, or `uncancel`) and returns exact or provider-calculated amounts
valid for 15 minutes. Execution accepts only the `previewToken` with an `Idempotency-Key` and
rejects expired previews, catalog or customer drift, or a changed target. A durable
subscription-change result is HTTP 202; every other result, including a cancellation, is HTTP 200.

### Cancelling and uncancelling a subscription

`cancel` names `externalSubscriptionId` and an `effectiveMode`; `uncancel` names the subscription
alone:

```json
{ "intent": { "kind": "cancel", "externalSubscriptionId": "sub_123", "effectiveMode": "immediate" } }
{ "intent": { "kind": "cancel", "externalSubscriptionId": "sub_123", "effectiveMode": "period_end" } }
{ "intent": { "kind": "uncancel", "externalSubscriptionId": "sub_123" } }
```

The preview carries no line items and a zero total, because a cancellation moves no money, and adds
a `cancellation` object: the `action` it would perform (`cancel`, `uncancel`, or `none`), when
access ends (`accessEndsAt`), the `cancelAtPeriodEnd` state it would leave, whether granted
allocations are kept, when open postpaid usage settles, the queued change it would supersede, and
the account's active add-on subscriptions. Asking for a state that already holds previews as
`none`: a `period_end` cancel on a subscription that already ends at its period end, or an
`uncancel` with nothing pending. Executing such a preview calls no provider and returns
`action: "none"`.

Execution returns
`{ "kind": "subscription_cancellation", "action", "externalSubscriptionId", "effectiveMode",
"effectiveAt", "cancelAtPeriodEnd", "supersededChangeId" }`.

What a cancellation does, on Stripe and through the customer portal alike:

- An **immediate** cancel ends the subscription and its access entitlements — boolean features,
  seats and postpaid overage — at once, and asks the provider for no proration credit.
- Plan **allocations already granted** for the paid period stay spendable until their own expiry.
  Allocations are reversed only when money goes back, through the existing `refund.sync` reversal.
- **Postpaid usage is not accelerated.** Overage accrued in the open period settles when that usage
  window ends, on the schedule it already had; the invoice is then billed to the customer against
  their saved default payment method, because the subscription is gone.
- A cancel **supersedes** the subscription's queued change: it is marked `cancelled` and its
  promotion use released. `uncancel` does not restore it — request the change again.
- A **base plan with active add-on subscriptions is refused** with `ADDON_SUBSCRIPTIONS_ACTIVE`
  (409), whose `details.addOnSubscriptionIds` names them; cancel the add-ons first. Cancelling an
  add-on itself is never held back.

Typed refusals: `SUBSCRIPTION_NOT_CANCELLABLE` (409) when the subscription has already ended, so
there is nothing left to cancel or to uncancel; `ADDON_SUBSCRIPTIONS_ACTIVE` (409);
`SUBSCRIPTION_CHANGE_PENDING` (409) while a worker is applying that subscription's change, which is
retryable; and `SUBSCRIPTION_PERIOD_MISSING` (409) for `period_end` without a known period end.

Local subscription state still arrives only through the provider webhook, so `cancelAtPeriodEnd`
and the subscription's status change when Stripe reports them, not when execution returns.

Limitation: a Stripe subscription schedule attached outside Quotum is invisible here. Quotum
cancels the subscription; it does not release or amend a schedule that may recreate it.

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
`GET /v1/admin/catalog` returns the active intent and needs project authentication only. See
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
declarations: it stays readable, and preview still compares a new intent against it. Publish checks
capabilities after it finds the preview token, so retrying a publish that already succeeded
returns its stored result with `duplicate: true`. A successful preview also reports
`providerCompatibility`; see
[Provider capabilities and available actions](#provider-capabilities-and-available-actions).

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

The backend SDK (`quotum-api/sdk`) wraps catalog, commercial, usage, provider capability, and
selected admin calls and keeps credentials server-side. Its admin reads (`admin.customer`,
`admin.searchCustomers`, `admin.storeEvents`, `admin.storeEvent`, `admin.projectionJobs`,
`admin.statsSummary`) and `accounts.controls` use project authentication only and never send the
operator key; `admin.storeEvent` never requests the raw provider payload. On a 429,
`BillingApiError.rateLimitResetAt` carries the `ratelimit-reset` timestamp. The read-only
[MCP server](mcp.md) for coding agents is built on these reads.

An applied catalog migration settles once when the subscription is synchronized. Later updates,
including an explicit downgrade or a provider-side return to an earlier plan, cannot replay that
historical migration. Stripe subscription-item IDs can remain unchanged across plan versions;
Quotum transfers their live association to the target price component and retains the inactive
source component rows and existing license-pool references. Returning to an earlier version reuses
its component rows.

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

## Provider capabilities and available actions

Two reads show what the capability declarations allow before a request fails. Both need project
authentication only:

```http
GET /v1/admin/providers/capabilities
GET /v1/billing-accounts/:billingAccountId/available-actions
```

The SDK exposes them as `client.providers.capabilities()` and
`client.commercial.availableActions(billingAccountId)`. The merchant billing proxy serves them to
members with `billing.read` in active environments, as
`GET /api/billing/admin/providers/capabilities` and
`GET /api/billing/admin/billing-accounts/:billingAccountId/available-actions`.

Both reads use persisted state only: connection rows and billing records. They never call a
provider, refresh a token, or decrypt a secret. They list the admitted providers (`apple`,
`google`, `stripe`); planned providers never appear. Every entry is a verdict with the shape
described in [Provider capability errors](#provider-capability-errors), whose `outcome` is
`available`, `blocked`, or `undetermined`.

The capabilities read returns one entry per provider with its `channel`, `connectionKind`,
`connection`, and a verdict for every operation in contract order. Operations are evaluated through
the configuration layer, so conditions of a single request, such as a subscription's status, are not
checked. `connection` reports whether an active version exists (`configured`), `enabled`,
`validated`, `validatedAt`, and `accountIdentity`. `validated` means the active version was
validated; unlike environment readiness, no 15-minute window applies. `connection` is `null` only
when the runtime cannot read connection state, and connection conditions are then `undetermined`.

These reads treat every operation as needing a validated connection. New work also needs an enabled
one, while recovery work (`webhook.ingest`, `event.replay`, `subscription.reconcile`,
`settlement.collect_finalized_charge`, `adjustment.issue`, `refund.sync`, and `topup.automatic`)
continues on a disabled connection. A missing connection therefore reports `CONNECTION_DISABLED`
and `CONNECTION_VALIDATION_REQUIRED` for new work and only `CONNECTION_VALIDATION_REQUIRED` for
recovery work. An environment with a validated Stripe connection and no Apple connection returns,
abbreviated:

```json
{
  "success": true,
  "data": {
    "schemaVersion": 1,
    "generatedAt": "2026-09-18T12:00:00.000Z",
    "providers": [
      {
        "provider": "apple",
        "channel": "ios",
        "connectionKind": "apple",
        "connection": {
          "configured": false,
          "enabled": false,
          "validated": false,
          "validatedAt": null,
          "accountIdentity": null
        },
        "operations": [
          {
            "provider": "apple",
            "operation": "webhook.ingest",
            "outcome": "blocked",
            "level": "native",
            "blockingLayer": "configuration",
            "reasons": [
              {
                "code": "CONNECTION_VALIDATION_REQUIRED",
                "layer": "configuration",
                "condition": { "kind": "connection_validated" },
                "observed": { "connectionValidated": false },
                "resolution": { "kind": "merchant_configuration", "connectionKind": "apple" }
              }
            ]
          }
        ]
      },
      {
        "provider": "stripe",
        "channel": "web",
        "connectionKind": "stripe",
        "connection": {
          "configured": true,
          "enabled": true,
          "validated": true,
          "validatedAt": "2026-09-18T11:40:00.000Z",
          "accountIdentity": "acct_1Voysee"
        },
        "operations": [
          {
            "provider": "stripe",
            "operation": "checkout.hosted",
            "outcome": "available",
            "level": "native",
            "blockingLayer": null,
            "reasons": []
          }
        ]
      }
    ]
  }
}
```

The available-actions read evaluates, for every provider, the operations a billing account can
start: `checkout.hosted`, `checkout.plan`, `purchase.verify`, `portal.session`,
`topup.customer_initiated`, `topup.automatic`, and `promotion.code_entry`. `subscriptions` lists
the account's live subscriptions (status `active`, `grace_period`, `billing_retry`, or `cancelled`,
and not past their expiry), newest first. Each carries its provider subscription `id`, its
`pendingChange` (the pending or processing change, or `null`), and the
`subscription.change.preview`, `subscription.change.apply`, and `subscription.change.period_end`
verdicts of its own provider, checked against its status and renewal date. An unknown billing
account returns `200` with `customerExists: false`, no subscriptions, and the account verdicts; the
read never creates a customer.

Only the provider knows whether a customer has a saved payment method, so a condition on it is
`undetermined` with resolution `checked_at_execution`: the request itself decides. Stripe's
`topup.automatic` is reported this way. Treat `undetermined` as possible, not as refused.
Abbreviated:

```json
{
  "success": true,
  "data": {
    "schemaVersion": 1,
    "billingAccountId": "acct_1",
    "customerExists": true,
    "generatedAt": "2026-09-18T12:00:00.000Z",
    "account": [
      {
        "provider": "stripe",
        "operation": "topup.automatic",
        "outcome": "undetermined",
        "level": "quotum_composed",
        "composedVia": "Stripe invoices with a top-up price line",
        "blockingLayer": null,
        "reasons": [
          {
            "code": "FACT_UNAVAILABLE",
            "layer": "operation",
            "condition": {
              "kind": "saved_payment_method",
              "required": true,
              "resolveWith": "topup.customer_initiated"
            },
            "observed": { "savedPaymentMethod": "unknown" },
            "resolution": { "kind": "checked_at_execution" }
          }
        ]
      }
    ],
    "subscriptions": [
      {
        "id": "sub_1",
        "provider": "stripe",
        "channel": "web",
        "status": "active",
        "planKey": "pro",
        "currentPeriodEnd": "2026-10-18T12:00:00.000Z",
        "cancelAtPeriodEnd": false,
        "pendingChange": {
          "changeId": "11111111-1111-4111-8111-111111111111",
          "status": "pending",
          "effectiveMode": "period_end",
          "effectiveAt": "2026-10-18T12:00:00.000Z"
        },
        "actions": [
          {
            "provider": "stripe",
            "operation": "subscription.change.apply",
            "outcome": "available",
            "level": "native",
            "blockingLayer": null,
            "reasons": []
          }
        ]
      }
    ]
  }
}
```

A successful catalog preview (`POST /v1/admin/catalog/preview`, and the merchant
`POST /api/billing/admin/catalog/preview`) also returns `providerCompatibility`, judged on the
declarations alone. Each entry's bindings come first and are always compatible, because preview
rejects an incompatible one. They are followed by one hypothetical entry, with `productKey: null`,
for each admitted provider the entry does not bind, which shows whether that provider could be
added. A plan with a trial bound only to Stripe lists Apple and Google as `compatible: false` with a
`PROVIDER_MANAGED` verdict for `catalog.trial`.

Environment readiness (`POST /api/platform/environments/readiness`) returns `blockerDetails` next
to `blockers`, whose strings do not change. The gating entries (`gating: true`) mirror `blockers`
one for one and in order, and add the `connectionKind`, the `provider` for a provider connection,
and for a `*_VALIDATION_REQUIRED` blocker the `observed` `validatedAt` and `maxAgeSeconds` (900).
Only gating entries block activation. Non-gating entries follow them and compare the published
catalog with the environment's connections: one per blocked provider operation, with the capability
error `code` of the layer that blocks it (see
[Provider capability errors](#provider-capability-errors)), the `provider`, the `operation`, the
catalog `targets` that need it, and the first blocking `reason`. A plan's own bindings are judged
on `catalog.trial` or `catalog.addon` when the plan has a trial or is an add-on, and otherwise on
`catalog.product.subscription`; price bindings on their `catalog.price.*` operations, and top-up
bindings on `catalog.topup`. A catalog that binds a provider whose connection is missing or
disabled reports `PROVIDER_CAPABILITY_NOT_CONFIGURED` with reason `CONNECTION_DISABLED`.
Undetermined verdicts are left out. Requests do not check these connection conditions yet: a
request to a provider without a usable connection still fails with
`BILLING_PROVIDER_NOT_CONFIGURED` (`501` for Apple and Google, `503` for Stripe), and catalog
publish does not look at connections. An excerpt:

```json
"blockerDetails": [
  {
    "code": "STRIPE_VALIDATION_REQUIRED",
    "gating": true,
    "connectionKind": "stripe",
    "provider": "stripe",
    "observed": { "validatedAt": "2026-09-18T11:40:00.000Z", "maxAgeSeconds": 900 }
  },
  {
    "code": "PROVIDER_CAPABILITY_NOT_CONFIGURED",
    "gating": false,
    "connectionKind": "apple",
    "provider": "apple",
    "operation": "catalog.topup",
    "targets": [{ "kind": "topup", "key": "credits_100" }],
    "reason": {
      "code": "CONNECTION_DISABLED",
      "layer": "configuration",
      "condition": { "kind": "connection_enabled" },
      "observed": { "connectionEnabled": false },
      "resolution": { "kind": "merchant_configuration", "connectionKind": "apple" }
    }
  }
]
```

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
  redacted; refused for a read-only credential).
- `GET /v1/admin/catalog`: the published catalog with its revision. Every other catalog route,
  reads included, is an operator route.
- `GET /v1/admin/stats/summary`.
- `GET /v1/admin/providers/capabilities`; see
  [Provider capabilities and available actions](#provider-capabilities-and-available-actions).

Operator routes:

- `GET /v1/admin/catalog/products`, `GET /v1/admin/catalog/store-products`,
  `POST /v1/admin/catalog/preview`, `POST /v1/admin/catalog/publish`.
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
