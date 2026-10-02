# Quickstart

- Document kind: Current behavior

This guide runs the real service against a local Postgres, publishes a catalog, records a synthetic
purchase through the guarded fake Stripe boundary, meters usage, and then publishes a set of plan
examples. No provider account is needed. It takes about five minutes. The fixtures it uses are in [`examples/quickstart/`](../examples/quickstart/).

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

The platform bootstrap creates the topology a manifest declares and issues each declared credential
once, into a `0600` file that is never printed. Running it again with an extended manifest adds
only the missing rows; see [deployment](deployment.md) for the rules.

```sh
export BILLING_PLATFORM_BOOTSTRAP_JSON="$(cat examples/quickstart/platform.json)"
umask 077
bun run platform:bootstrap -- --apply --credentials-out ./quickstart-credentials.json
bun run platform:bootstrap -- --check

export TOKEN="$(jq -r '.credentials[] | select(.projectInstanceKey=="acme") | .credential' quickstart-credentials.json)"
```

The `acme` instance is a sandbox, so its credential starts with `sqpk_`; production credentials
start with `pqpk_`.

## 3. Import the store products the catalogs will bind to

Provider bindings in a published catalog adopt pre-provisioned store products. The development import
creates the Stripe web products both catalogs in this guide bind to: the `credits_10` top-up used in
steps 5 to 7, and the products of the plan examples in step 8. It writes only while nothing has been
published, so run it before step 5.

```sh
BILLING_CATALOG_IMPORT_JSON="$(cat examples/quickstart/catalog-import.json)" bun run catalog:provision
```

## 4. Start the service with the fake Stripe boundary

The guarded test entrypoint loads project connections from `BILLING_TEST_CONNECTIONS_JSON` in memory
and replaces Stripe network calls with a deterministic fake. It refuses to start outside
`BILLING_ENV=test`. This guide only uses `/v1`, so it runs [headless](deployment.md#headless-mode),
without the merchant platform and its settings. Run it in a second terminal:

```sh
export POSTGRES_URI="postgres://postgres:postgres@127.0.0.1:5432/quotum"
BILLING_ENV=test BILLING_TEST_FAKE_STRIPE=true \
BILLING_OPERATOR_API_KEY=quickstart-operator-key-0001 \
QUOTUM_SECRETS_KEY_ID=quickstart QUOTUM_SECRETS_KEY_BASE64="$(head -c 32 /dev/zero | base64)" \
QUOTUM_MERCHANT_ENABLED=false \
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

Explicit creation is idempotent, including for the account recorded by the preceding purchase.

```sh
curl -s -X PUT localhost:3000/v1/billing-accounts/user_1 "${AUTH[@]}" -d '{}'
curl -s -X POST localhost:3000/v1/billing-accounts/user_1/usage/check "${AUTH[@]}" \
  -d '{"featureId":"api_calls","value":"3"}' | jq '.data | {allowed, reason}'

curl -s -X POST localhost:3000/v1/billing-accounts/user_1/usage/consume "${AUTH[@]}" \
  -H "Idempotency-Key: quickstart-consume-1" \
  -d '{"featureId":"api_calls","value":"3"}' | jq '.data.balance | {granted, consumed, available}'
# {"granted":"10","consumed":"3","available":"7"}

curl -s localhost:3000/v1/billing-accounts/user_1/usage/events "${AUTH[@]}" | jq '.data[] | {operation, featureKey, quantity}'
```

Repeat the consume call with the same `Idempotency-Key` and you get the original receipt back without
a second charge. Change the body under the same key and you get `409 IDEMPOTENCY_CONFLICT`.

## 8. Publish the plan examples

[`examples/quickstart/catalog-plans.json`](../examples/quickstart/catalog-plans.json) keeps everything
the first catalog published and adds one plan of each kind, written in the
[canonical spelling](catalog.md#canonical-intent):

- `free`, the catalog's default plan: no price, 100 AI credits a month and 10 exports a day. Every
  created account without a paid base plan holds it.
- `pro`, a monthly base plan priced at $20.00 by its `basePrice`: 1,000 AI credits a month and 1,000
  exports a day.
- `team`, priced only through its seats (`licensed_quantity`, $8.00 a seat), with no `basePrice`: 5
  seats, 5,000 AI credits a month and 5,000 exports a day.
- `unlimited_exports`, an add-on whose `unlimited_usage` item lifts the daily export limit of the
  base plan it is bought with.
- `credits_1000`, a top-up whose credits expire one calendar year after purchase.

Each base plan declares its own `exports` limit, because an account whose plans declare no limit for
a metered feature that some plan limits gets none of it. `api_calls` stays priced by its rate card in
AI credits; a meter limit on it would stop calls drawing on the wallet. Publish it as revision 2:

```sh
CATALOG="$(cat examples/quickstart/catalog-plans.json)"
PREVIEW="$(curl -s -X POST localhost:3000/v1/admin/catalog/preview "${AUTH[@]}" "${OPS[@]}" \
  -d "{\"expectedRevision\":1,\"catalog\":$CATALOG}")"
echo "$PREVIEW" | jq '.data | {deprecations, advisories, plansCreated: .impact.plansCreated}'
# {"deprecations":[],"advisories":[],"plansCreated":4}

curl -s -X POST localhost:3000/v1/admin/catalog/publish "${AUTH[@]}" "${OPS[@]}" \
  -d "{\"expectedRevision\":1,\"previewToken\":$(echo "$PREVIEW" | jq .data.previewToken),\"catalog\":$CATALOG}" | jq .data.revision
# 2
```

A new account holds the free plan as soon as it is created:

```sh
curl -s -X PUT localhost:3000/v1/billing-accounts/user_2 "${AUTH[@]}" -d '{}'
curl -s -X POST localhost:3000/v1/billing-accounts/user_2/usage/consume "${AUTH[@]}" \
  -H "Idempotency-Key: quickstart-free-consume-1" \
  -d '{"featureId":"api_calls","value":"3"}' | jq .data.allowed
# true

curl -s localhost:3000/v1/billing-accounts/user_2/balances/ai_credits "${AUTH[@]}" | jq '.data | {granted, consumed, available}'
# {"granted":"100","consumed":"3","available":"97"}

curl -s -X POST localhost:3000/v1/billing-accounts/user_2/usage/check "${AUTH[@]}" \
  -d '{"featureId":"exports","value":"11"}' | jq '.data | {allowed, limit: .balance.granted}'
# {"allowed":false,"limit":"10"}
```

`GET /v1/admin/catalog` returns the published catalog with every default spelled out; previewing that
output unchanged creates nothing. `bun run catalog format examples/quickstart/catalog.json` prints the
starter catalog the same way, rewriting its legacy `expiresAfterSeconds: null` as
`expiry: { "mode": "forever" }`.

## Clean up

```sh
docker rm -f quotum-postgres
rm quickstart-credentials.json
```

## Next steps

- [Deployment and configuration](deployment.md) for a real environment.
- [Provider integrations](providers.md) for Apple, Google, and Stripe.
- [API guide](api.md) for request rules and admin routes, with [metering](metering.md) and
  [catalog publication](catalog.md) for the calls this quickstart made.
- [Operations](operations.md) for backup, upgrade, and rollback.
