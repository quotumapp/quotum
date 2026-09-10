# Quickstart

- Document kind: Current behavior

This guide runs the real service against a local Postgres, publishes a catalog, records a synthetic
purchase through the guarded fake Stripe boundary, and meters usage. No provider account is needed.
It takes about five minutes. The fixtures it uses are in [`examples/quickstart/`](../examples/quickstart/).

Prerequisites: [Bun](https://bun.sh) 1.4.x, Docker, `curl`, `jq`, and `openssl`.

## 1. Start Postgres and apply migrations

```sh
bun install --frozen-lockfile

docker run -d --name quotum-postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=quotum postgres:18-alpine

export POSTGRES_URI="postgres://postgres:postgres@127.0.0.1:5432/quotum"
bun run migrate
bun run migrate:status
```

## 2. Create a project and its credential

The platform bootstrap applies an exact topology manifest and issues each declared credential once,
into a `0600` file that is never printed.

```sh
export BILLING_PLATFORM_BOOTSTRAP_JSON="$(cat examples/quickstart/platform.json)"
umask 077
bun run platform:bootstrap -- --apply --credentials-out ./quickstart-credentials.json
bun run platform:bootstrap -- --check

export TOKEN="$(jq -r '.credentials[] | select(.projectInstanceKey=="acme") | .credential' quickstart-credentials.json)"
```

## 3. Import the store product the catalog will bind to

Provider bindings in a published catalog adopt pre-provisioned store products. The development import
creates one Stripe web top-up product, `credits_10`.

```sh
BILLING_CATALOG_IMPORT_JSON="$(cat examples/quickstart/catalog-import.json)" bun run catalog:provision
```

## 4. Start the service with the fake Stripe boundary

The guarded test entrypoint loads project connections from `BILLING_TEST_CONNECTIONS_JSON` in memory
and replaces Stripe network calls with a deterministic fake. It refuses to start outside
`BILLING_ENV=test`. Merchant authentication is always on, so it also needs an auth secret and legal
versions; in test mode merchant mail stays in memory. Run it in a second terminal:

```sh
export POSTGRES_URI="postgres://postgres:postgres@127.0.0.1:5432/quotum"
BILLING_ENV=test BILLING_TEST_FAKE_STRIPE=true \
BILLING_OPERATOR_API_KEY=quickstart-operator-key-0001 \
QUOTUM_SECRETS_KEY_ID=quickstart QUOTUM_SECRETS_KEY_BASE64="$(head -c 32 /dev/zero | base64)" \
QUOTUM_AUTH_SECRET=quickstart-merchant-secret-at-least-32-chars \
MERCHANT_TERMS_VERSION=2026-09-01 MERCHANT_PRIVACY_VERSION=2026-09-01 \
BILLING_TEST_CONNECTIONS_JSON="$(cat examples/quickstart/connections.json)" \
bun run test:stripe-entrypoint
```

Back in the first terminal:

```sh
curl -s localhost:3000/ready
# {"status":"ok"}
```

## 5. Publish a catalog

The catalog declares a wallet feature `ai_credits`, a metered feature `api_calls` priced at one credit
per call, and a `credits_10` top-up bound to the imported Stripe product. Publication is a two-step
preview and publish with an exact-intent token.

```sh
AUTH=(-H "Authorization: Bearer $TOKEN" -H "content-type: application/json")
OPS=(-H "X-Billing-Operator-Key: quickstart-operator-key-0001" -H "X-Billing-Actor: quickstart@example.com")

PREVIEW_TOKEN="$(curl -s -X POST localhost:3000/v1/admin/catalog/preview "${AUTH[@]}" "${OPS[@]}" \
  -d "{\"expectedRevision\":null,\"catalog\":$(cat examples/quickstart/catalog.json)}" | jq -r .data.previewToken)"

curl -s -X POST localhost:3000/v1/admin/catalog/publish "${AUTH[@]}" "${OPS[@]}" \
  -d "{\"expectedRevision\":null,\"previewToken\":\"$PREVIEW_TOKEN\",\"catalog\":$(cat examples/quickstart/catalog.json)}" | jq .data.revision
# 1
```

## 6. Record a synthetic purchase

Post a signed `checkout.session.completed` event for `credits_10`. The signature is computed the way
Stripe computes it: HMAC-SHA256 over `<timestamp>.<raw body>` with the webhook secret from
`examples/quickstart/connections.json`.

```sh
BODY="$(cat examples/quickstart/checkout-webhook.json)"
TS="$(date +%s)"
SIGNATURE="t=$TS,v1=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac whsec_quickstart_placeholder | awk '{print $NF}')"

curl -s -X POST localhost:3000/v1/projects/acme/webhooks/stripe \
  -H "content-type: application/json" -H "stripe-signature: $SIGNATURE" \
  --data-binary "$BODY" | jq .data.status
# "processed"

curl -s localhost:3000/v1/billing-accounts/user_1/balances/ai_credits "${AUTH[@]}" | jq '.data | {granted, consumed, available}'
# {"granted":"10","consumed":"0","available":"10"}
```

## 7. Meter usage

```sh
curl -s -X POST localhost:3000/v1/billing-accounts/user_1/usage/check "${AUTH[@]}" \
  -d '{"featureKey":"api_calls","quantity":"3"}' | jq '.data | {allowed, reason}'

curl -s -X POST localhost:3000/v1/billing-accounts/user_1/usage/consume "${AUTH[@]}" \
  -H "Idempotency-Key: quickstart-consume-1" \
  -d '{"featureKey":"api_calls","quantity":"3"}' | jq '.data.balance | {granted, consumed, available}'
# {"granted":"10","consumed":"3","available":"7"}

curl -s localhost:3000/v1/billing-accounts/user_1/usage/events "${AUTH[@]}" | jq '.data[] | {operation, featureKey, quantity}'
```

Repeat the consume call with the same `Idempotency-Key` and you get the original receipt back without
a second charge. Change the body under the same key and you get `409 IDEMPOTENCY_CONFLICT`.

## Clean up

```sh
docker rm -f quotum-postgres
rm quickstart-credentials.json
```

## Next steps

- [Deployment and configuration](deployment.md) for a real environment.
- [Provider integrations](providers.md) for Apple, Google, and Stripe.
- [API guide](api.md) for the metering, catalog, and admin surfaces.
- [Operations](operations.md) for backup, upgrade, and rollback.
