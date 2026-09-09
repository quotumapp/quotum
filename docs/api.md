# API guide

- Document kind: Current behavior

The complete HTTP surface is published as [`contracts/v1/openapi.json`](../contracts/v1/openapi.json)
with the runtime error inventory in [`contracts/v1/errors.json`](../contracts/v1/errors.json). Billing JSON operations use the envelope `{"success":true,"data":...}` or
`{"success":false,"error":{"code":...,"message":...}}`. Error codes are extensible, so handle unknown
codes. Health/metrics and authentication/provider callback surfaces have their own response shapes;
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

## Admin operations

Admin routes require project authentication; operational mutations also require
`X-Billing-Operator-Key`.

Reads:

- `GET /v1/admin/customers/search?q=...`: prefix match across account, customer, provider, and
  transaction ids; queries are capped at 128 characters.
- `GET /v1/admin/customers/by-billing-account/:billingAccountId`,
  `GET /v1/admin/customers/:customerId`, and per-customer `purchases`, `subscriptions`,
  `store-events`, and `projection-jobs`.
- `GET /v1/admin/purchases`, `/subscriptions`, `/store-events`, `/projection-jobs`.
- `GET /v1/admin/store-events/:eventId` with optional `includeRawPayload=true` (audit-logged, secrets
  redacted).
- `GET /v1/admin/catalog/products`, `GET /v1/admin/catalog/store-products`,
  `GET /v1/admin/stats/summary`.

Operations:

- `GET /v1/admin/catalog`, `POST /v1/admin/catalog/preview`, `POST /v1/admin/catalog/publish`.
- `POST /v1/admin/contracts/preview`, `POST /v1/admin/contracts/publish`,
  `GET /v1/admin/contracts/:billingAccountId`,
  `DELETE /v1/admin/contracts/:billingAccountId/:contractId`.
- `POST /v1/admin/catalog-migrations/preview`, `POST /v1/admin/catalog-migrations/publish`.
- `POST /v1/admin/auto-topups/:billingAccountId/:policyId/reset`.
- `POST /v1/admin/store-events/:eventId/replay`.
- `POST /v1/admin/reconciliation/subscriptions/run`.
- `POST /v1/admin/projection-jobs/:jobId/retry`.
- `GET /v1/admin/metrics`.
