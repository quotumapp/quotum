# Provider capability errors and reads

- Document kind: Current behavior

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
| `GET /v1/billing-accounts/:billingAccountId/payment-setup-sessions/:sessionId` | `paymentMethods.setupSession` |
| `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions` with a `planKey` | `checkout.createPlan` |
| `POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes` | `commercial.requestChange` |
| `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId/expire` | `checkout.expire` |

The merchant billing proxy returns the same code and `details` for its billing-account, commercial
preview and commercial action operations. On `/v1`, commercial execution and subscription changes
reject a missing `Idempotency-Key` with `400` before this check. When the provider has no connection
at all, `BILLING_PROVIDER_NOT_CONFIGURED` carries no `details` (`503` for Stripe and Paddle, `501`
for Apple and Google). `503 STRIPE_NOT_CONFIGURED` is narrower: only the Stripe service returns it,
when its Stripe client or billing storage lacks a dependency of subscription changes, commercial
actions, checkout expiry, or recurring pricing.

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
provider, refresh a token, or decrypt a secret. They list the admitted providers (`apple`, `google`,
`stripe`, `paddle`); a provider the contract only plans never appears. Every entry is a verdict with
the shape described in [Provider capability errors](#provider-capability-errors), whose `outcome` is
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
          "accountIdentity": "acct_1Acme"
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
`payment_method.setup`, `topup.customer_initiated`, `topup.automatic`, and
`promotion.code_entry`. `subscriptions` lists
the account's live subscriptions (status `active`, `grace_period`, `billing_retry`, or `cancelled`,
and not past their expiry), newest first. Each carries its provider subscription `id`, its
`pendingChange` (the pending or processing change, or `null`), and the
`subscription.change.preview`, `subscription.change.apply`, `subscription.change.period_end`,
`subscription.cancel`, and `subscription.uncancel` verdicts of its own provider, checked against
its status, pending cancellation and renewal date. A `cancelled` Stripe subscription has already
ended at Stripe, so its cancel and uncancel verdicts are `blocked` with `SUBSCRIPTION_STATE`, as
execution refuses them with `SUBSCRIPTION_NOT_CANCELLABLE`. The verdicts do not model a change a
worker is applying (`SUBSCRIPTION_CHANGE_PENDING`, retryable) or a base plan's active add-ons
(`ADDON_SUBSCRIPTIONS_ACTIVE`); `pendingChange` shows the former. An unknown billing
account returns `200` with `customerExists: false`, no subscriptions, and the account verdicts; the
read never creates a customer.

Only the provider knows whether a customer has a saved payment method, so a condition on it is
`undetermined` with resolution `checked_at_execution`: the request itself decides. Stripe's
`topup.automatic` is reported this way, and its condition's `resolveWith` names
`payment_method.setup` — the hosted setup that saves a method without charging for it. Treat `undetermined` as possible, not as refused.
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
              "resolveWith": "payment_method.setup"
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

## Catalog preview compatibility

A successful catalog preview (`POST /v1/admin/catalog/preview`, and the merchant
`POST /api/billing/admin/catalog/preview`) also returns `providerCompatibility`, judged on the
declarations alone. Each entry's bindings come first and are always compatible, because preview
rejects an incompatible one. They are followed by one hypothetical entry, with `productKey: null`,
for each admitted provider the entry does not bind, which shows whether that provider could be
added. A plan with a trial bound only to Stripe lists Apple and Google as `compatible: false` with a
`PROVIDER_MANAGED` verdict for `catalog.trial`.

## Environment readiness

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
`BILLING_PROVIDER_NOT_CONFIGURED` (`501` for Apple and Google, `503` for Stripe and Paddle), and
catalog publish does not look at connections. An excerpt:

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
