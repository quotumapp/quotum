# API guide

- Document kind: Current behavior

The complete HTTP surface is published as [`contracts/v1/openapi.json`](../contracts/v1/openapi.json)
with the runtime error inventory in [`contracts/v1/errors.json`](../contracts/v1/errors.json). Billing JSON operations use the envelope `{"success":true,"data":...}` or
`{"success":false,"error":{"code":...,"message":...}}`. An error may also carry an optional
`details` object with structured context for its code (see
[Provider capability errors](provider-capabilities.md#provider-capability-errors)); the key is absent when there is none.
Error codes are extensible, so handle unknown codes and ignore `details` keys you do not recognize.
Health/metrics and authentication/provider callback surfaces have their own response shapes;
consult the generated contract rather than applying the billing envelope to every route.

## Topic guides

This guide covers what every `/v1` call shares, read-only credentials, the backend SDK and the
admin routes. Each billing topic has its own guide:

- [Metering](metering.md): checks, consumes, reservations, pricing, meter limits, spend and usage
  limits, alerts, usage reads and operation recovery.
- [Subscriptions and commercial actions](subscriptions.md): previews and execution, allowances
  across a plan change, Stripe plan-version updates, cancellation and saving a payment method.
- [Catalog publication](catalog.md): preview and publish, validation, allowance windows, the
  default plan marker, catalog automation and migrations.
- [Promotions](promotions.md): discounts, reward codes, validation, redemption and revocation.
- [Trials, default plan and operator grants](grants.md): plan grants without a provider, support
  credit and administrative debits.
- [Provider capability errors and reads](provider-capabilities.md): capability errors, the
  capability and available-actions reads, and environment readiness details.

## Requests and responses

`/v1` and `/api` responses carry `X-Request-Id`. On `/v1`, a caller's own `X-Request-Id` is kept
when it is 1 to 128 characters of letters, digits, `.`, `_`, `:` and `-`; any other value is
replaced with a generated ID and never echoed or logged. `/v1` error bodies repeat it as
`error.requestId`, as the merchant API already does, so quote it when reporting a failure. A `401`
carries `WWW-Authenticate: Bearer realm="quotum"`, and a `429` carries `Retry-After` in whole
seconds, also repeated as `error.retryAfter`. Responses are sent with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`: billing state is private to the caller and changes with every
write.

`/v1` refuses, with `400 INVALID_REQUEST`, input the database could not store: a body nested more
than 64 levels deep; a NUL character or an unpaired surrogate in any body key or string, path
segment or query value; a numeric id beyond the signed 64-bit range; a date-time outside years 1 to
9999; and a decimal with more than 19 digits before the decimal point.

Where a `/v1` operation requires an `Idempotency-Key`, the key holds 1 to 200 characters after
surrounding whitespace is trimmed; usage operations additionally reject surrounding whitespace
instead of changing the caller's identity. Invalid keys answer `400 INVALID_REQUEST`. The contract lists
every query parameter an operation reads, including the admin list filters.

A `/v1` path that exists answers another method with `405 METHOD_NOT_ALLOWED` and an `Allow`
header listing the methods it accepts (`HEAD` wherever `GET` is); a path that does not exist answers
`404 NOT_FOUND`. A `/v1` request body sent with a `Content-Encoding` other than `identity` answers
`415 UNSUPPORTED_CONTENT_ENCODING`: bodies are read as sent and must not be compressed. A body over
256 KB answers `413 REQUEST_BODY_TOO_LARGE`. Bun itself answers a request line or headers beyond its
limits, and a body beyond its 128 MB limit, before the service runs, so those answers carry no JSON
envelope.

## Regenerating the contract

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

## Backend SDK

The separate public [`@quotum/sdk`](https://github.com/quotumapp/quotum-js) is developed in the
`quotum-js` repository. Its first preview covers explicit account/entity handles, feature-aware
checks, known-cost consumption, operation recovery and receipts. See [metering](metering.md) for
the matching server contract; a public SDK release must pin the API revision and pass packed
conformance. A local development artifact is not an npm publication or a frozen `/v1` contract.

The backend SDK (`quotum-api/sdk`) wraps catalog, commercial, usage, provider capability, and
selected admin calls and keeps credentials server-side. Its admin reads (`admin.customer`,
`admin.searchCustomers`, `admin.storeEvents`, `admin.storeEvent`, `admin.projectionJobs`,
`admin.statsSummary`) and `accounts.controls` use project authentication only and never send the
operator key; `admin.storeEvent` never requests the raw provider payload. Operator reads, such as
`adjustments.grants`, `adjustments.getGrant`, `adjustments.debits` and the promotion lists, need the
client's `operatorKey` only; operator changes also need its `actor`, and the client refuses them
before any request when either is missing. An `actor` set on the client is sent with reads too.
On a 429, `BillingApiError.rateLimitResetAt` carries the `ratelimit-reset` timestamp and
`BillingApiError.retryAfterSeconds` the `Retry-After` delay. A response whose body is empty or not
JSON, such as a proxy's text or HTML 502, raises `BillingApiError` with code `HTTP_ERROR` and the
HTTP status, so callers can retry on 5xx. The read-only
[MCP server](mcp.md) for coding agents is built on these reads.

Its `usage.check` and `usage.consume` methods now accept `featureId` and `value`, returning the
compact public results. Other usage methods retain their existing fields until their coordinated
cutover. The bundled client remains distinct from the standalone SDK's automatic retry and recovery
transport.

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
  [Provider capabilities and available actions](provider-capabilities.md#provider-capabilities-and-available-actions).

Operator routes:

- `GET /v1/admin/catalog/products`, `GET /v1/admin/catalog/store-products`,
  `POST /v1/admin/catalog/preview`, `POST /v1/admin/catalog/publish`.
- `POST /v1/admin/contracts/preview`, `POST /v1/admin/contracts/publish`,
  `GET /v1/admin/contracts/:billingAccountId`,
  `DELETE /v1/admin/contracts/:billingAccountId/:contractId`.
- `POST /v1/admin/catalog-migrations/preview`, `POST /v1/admin/catalog-migrations/publish`.
- `POST /v1/admin/auto-topups/:billingAccountId/:policyId/reset`.
- Promotion management under `/v1/admin/promotions` and
  `POST /v1/admin/promotion-redemptions/:redemptionId/revoke`; see [Promotions](promotions.md).
- Operator grants under `/v1/admin/operator-grants` and administrative debits under
  `/v1/admin/administrative-debits`; see
  [Operator grants and administrative debits](grants.md#operator-grants-and-administrative-debits).
- `POST /v1/admin/store-events/:eventId/replay`: an event of another project, or none, answers
  `404 NOT_FOUND`; one already processed, or leased by a worker that is still live, answers
  `409 STORE_EVENT_NOT_REPLAYABLE`.
- `POST /v1/admin/reconciliation/subscriptions/run`.
- `POST /v1/admin/projection-jobs/:jobId/retry`.
- `GET /v1/admin/metrics`.
