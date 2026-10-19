# Outbound webhooks

- Document kind: Current behavior

Outbound webhooks send billing events to HTTPS endpoints a project registers, each subscribed to
the event types it wants. They sit beside the [`billing_state_v1` projection](providers.md#projections):
a projection delivers the account's whole state to one product receiver, while a webhook delivers
one fact to every endpoint that subscribes to it. Each endpoint has its own signing secret, retry
state and replay.

Every route below is an operator route: it needs a project credential with full access, the
`X-Billing-Operator-Key` header and, on a write, `X-Billing-Actor`. Creating an endpoint and
rotating its secret also need an `Idempotency-Key`.

## Event types

`GET /v1/admin/webhook-event-types` lists the types an endpoint can subscribe to (`subscribable`)
and every type it can receive (`deliverable`, which adds `webhook.test`). An endpoint subscribes to
a list of types, or to every type when the list is empty, including types added later.

| Type | Recorded when | `data` |
| --- | --- | --- |
| `subscription.activated` | A subscription starts granting access: it is new, or comes back from `expired`, `refunded` or `revoked` | `subscription` and `previousAttributes` |
| `subscription.updated` | A subscription that grants access changes its status, product, expiry, period end, `cancelAtPeriodEnd` or `autoRenew` | `subscription` and `previousAttributes`, the changed attributes with their values before |
| `subscription.ended` | A subscription that granted access becomes `expired`, `refunded` or `revoked` | `subscription` and `previousAttributes` |
| `invoice.paid`, `invoice.payment_failed` | Stripe reports a subscription invoice paid, or a payment for it failed | `invoice`: Quotum's invoice id, Stripe's id, status, amount paid in minor units, currency, subscription |
| `refund.recorded`, `dispute.recorded` | A refund or a dispute of a payment is recorded; credits it funded are taken back | `reversal`, and `subscription` for a subscription payment, as the projection carries them |
| `trial.ending`, `trial.ended` | A trial ends within three days, or a trial without a paid successor ended | `trial`, as the projection carries it |
| `plan_grant.ending`, `plan_grant.ended` | The plan a redeemed promotion code gave ends within three days, or ended | `planGrant`, as the projection carries it |
| `usage_alert.triggered` | Usage crosses an alert's threshold in a window | `alert`, `window`, the `threshold` in units, `currentValue` and the window's `crossing` count |
| `auto_topup.succeeded` | An automatic top-up charged and added its credits | `autoTopup`: job, policy, feature, top-up, amounts, currency, provider ids |
| `auto_topup.failed` | An automatic top-up failed for good; the policy may be suspended | `autoTopup` with `error` |
| `auto_topup.action_required` | An automatic top-up needs the customer, such as a purchase in a store app or authentication | `autoTopup` with `error` |

A subscription event's `subscription` is the subscription after the change. The trial,
plan-grant, refund and dispute events carry the same fact as the `billing_state_v1` projection, from
the same recorded change, so a receiver of both sees each fact once in each. A retried top-up
failure records nothing until it succeeds or fails for good.

A billing fact is recorded as an event in the same database transaction as the fact, and only
while an enabled endpoint of the project subscribes to its type. A project without webhooks
records nothing, and an event a fact produced before any endpoint subscribed cannot be replayed
later. The worker then gives each recorded event one delivery per endpoint that is enabled,
subscribes to the type and existed when the event was recorded.

## Endpoints

```http
POST   /v1/admin/webhook-endpoints
GET    /v1/admin/webhook-endpoints
GET    /v1/admin/webhook-endpoints/:endpointId
PATCH  /v1/admin/webhook-endpoints/:endpointId
DELETE /v1/admin/webhook-endpoints/:endpointId
```

`POST` takes `url`, an optional `description` (at most 500 characters), `eventTypes` (default
`[]`, every type) and `enabled` (default `true`), and answers `201` with the endpoint and its
signing `secret`. The secret is shown once: Quotum seals it at rest with the deployment's secrets
key, and a replay of the same request answers `200` with `"secret": null` and
`"secretDisclosed": false`. Reusing the idempotency key with other terms answers
`409 IDEMPOTENCY_CONFLICT`. A project instance has at most 20 endpoints
(`409 WEBHOOK_ENDPOINT_LIMIT_REACHED`), and a type that does not exist is
`400 WEBHOOK_EVENT_TYPE_UNKNOWN`.

The URL must be `https` without credentials or a fragment, at most 2,048 characters. Each delivery
resolves it again and sends only to public addresses, so a URL that later resolves somewhere
private fails its deliveries. A headless deployment that approves private receivers for
projections (`BILLING_PROJECTION_ALLOWED_NETWORKS`, `BILLING_PROJECTION_ALLOW_INSECURE_HTTP`;
see [deployment](deployment.md)) approves them for webhook endpoints too, and then also accepts
`http` URLs, which reach only the approved networks.

`PATCH` changes any of `url`, `description`, `eventTypes` and `enabled`. A disabled endpoint keeps
its pending deliveries and sends nothing until it is enabled again; its `disabledReason` is
`operator`. `DELETE` removes the endpoint and its deliveries; the events stay until retention.

## Deliveries

Each delivery is a `POST` of a JSON body with `content-type: application/json` and three
[Standard Webhooks](https://www.standardwebhooks.com) headers:

| Header | Value |
| --- | --- |
| `webhook-id` | The event id. It stays the same across retries and replays: deduplicate on it. |
| `webhook-timestamp` | Unix seconds when this attempt was signed. |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` of `<webhook-id>.<webhook-timestamp>.<body>`, one per signing secret, space-separated. |

The body is an envelope around the event's data:

```json
{
  "id": "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
  "type": "webhook.test",
  "version": 1,
  "createdAt": "2026-10-19T08:00:00.000Z",
  "occurredAt": "2026-10-19T08:00:00.000Z",
  "environment": "sandbox",
  "projectKey": "acme",
  "data": { "endpointId": "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20", "message": "A test delivery from Quotum" }
}
```

`billingAccountId` is present when the event is about an account. The schema of every type is
published in [`contracts/v1/domain-events.schema.json`](../contracts/v1/domain-events.schema.json)
with an example of each in
[`contracts/v1/domain-events.examples.json`](../contracts/v1/domain-events.examples.json). Ignore
fields and types you do not know: both grow without a new `version`.

Delivery is at least once and unordered. A retry, a replay or a lost acknowledgement can send the
same event again, and two events about one account can arrive in either order; `occurredAt` says
when each fact happened. For an account's current state, read it or use the projection.

### Verifying a delivery

Verify the raw body before parsing it, reject a `webhook-timestamp` more than five minutes away
from your clock, and accept the delivery when any signature in `webhook-signature` matches. Any
Standard Webhooks library does this with the secret (some take it without the `whsec_` prefix). The
backend SDK exports the same check:

```ts
import { verifyWebhookSignature } from "quotum-api/sdk";

const body = await request.text();
const ok = verifyWebhookSignature({
	secret: process.env.QUOTUM_WEBHOOK_SECRET!,
	body,
	webhookId: request.headers.get("webhook-id") ?? "",
	timestamp: request.headers.get("webhook-timestamp") ?? "",
	signature: request.headers.get("webhook-signature") ?? "",
});
```

### Retries

Any `2xx` answer delivers the event; its body is ignored. Anything else, or no answer within ten
seconds, is a failed attempt. Attempts are spaced one minute apart, then doubling up to a day, with
up to a second of jitter, and a `Retry-After` on a `429` or `503` delays the next attempt further,
up to a day. After `BILLING_EVENT_DELIVERY_MAX_ATTEMPTS` attempts (default 12, about 34 hours) the
delivery is `failed`.

An endpoint whose every delivery has failed for 72 hours is disabled with `disabledReason`
`failing`. Enabling it again clears that state and resumes its pending deliveries.

```http
GET  /v1/admin/webhook-deliveries?endpointId=&status=&eventType=&billingAccountId=&limit=&cursor=
POST /v1/admin/webhook-deliveries/:deliveryId/retry
POST /v1/admin/webhook-endpoints/:endpointId/test
POST /v1/admin/webhook-endpoints/:endpointId/replay
```

The list returns deliveries newest first with their status, attempts, last status code and last
error. `retry` queues a `failed` delivery again from its first attempt
(`409 WEBHOOK_DELIVERY_NOT_FAILED` otherwise). `test` queues a `webhook.test` event for that
endpoint alone and answers `202` with its `eventId` and `deliveryId`; a disabled endpoint answers
`409 WEBHOOK_ENDPOINT_DISABLED`. `replay` takes `from`, `to` and optional `eventTypes`, and queues
every event recorded in `[from, to)` that the endpoint subscribes to, each from its first attempt
with its original `webhook-id`; it answers `202` with `queued`, and refuses a window of more than
10,000 events (`409 WEBHOOK_REPLAY_TOO_LARGE`). A delivery in flight is left alone.

## Rotating the secret

```http
POST /v1/admin/webhook-endpoints/:endpointId/rotate-secret
{ "overlapHours": 24 }
```

Rotation discloses a new secret once, the same way creation does. For `overlapHours` (default 24,
0 to 168) deliveries carry a signature with the new secret and one with the replaced secret, so a
receiver can switch without missing a delivery; afterwards only the new secret signs. A retried
rotation with the same idempotency key changes nothing and returns no secret.

Endpoint secrets are sealed with the same deployment keys as connection secrets, and
`quotum connections rotate-secrets` re-seals both after a key change; see
[deployment](deployment.md#encryption-key-rotation).

## Retention and erasure

Events are kept for `BILLING_EVENT_RETENTION_DAYS` days (default 30), which bounds replay; a
delivery still pending then is dropped with its event. Once an erasure of a billing account is
requested, no delivery about the account is sent; the erasure waits while one is already being
delivered (blocker `webhook_delivery`), then deletes the account's events and their deliveries.
