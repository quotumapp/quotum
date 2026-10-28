# Real Stripe sandbox quickstart

- Document kind: Current behavior

Connect a Stripe sandbox to the normal Quotum runtime, buy ten credits through hosted Checkout,
and consume three. This exercises real Stripe API calls and signed sandbox events, encrypted
database-owned connections, product adoption and catalog publication. Stripe test payments move
no real money. The [five-minute quickstart](quickstart.md) remains the account-free billing demo.
To have Quotum create or reuse the product, price and webhook endpoint and verify signed delivery
for you, use [automated Stripe setup](stripe-setup.md); this walkthrough does each step by hand and
ends with a test payment.

Prerequisites: Bun 1.4.x, Docker, Bash, `curl`, `jq`, `openssl`, the
[Stripe CLI](https://docs.stripe.com/stripe-cli), and access to a Stripe sandbox where you can
create products and restricted keys. Allow time for account access and Dashboard configuration.
Run commands from the repository root. Use a dedicated sandbox; its products, prices, key and CLI
session must all belong to the same account and mode. No `--live` commands are used here.

The steps use three terminals: setup commands, the Quotum server, and Stripe event forwarding.
Use the fresh database below even if you tried the fake demo: its placeholder store mappings and
synthetic purchases are not real Stripe data.
Ports 55432 (Postgres) and 3010 (Quotum) must be available. If either is occupied, choose a free port
and change its occurrences in the environment file, Docker mapping and URLs below.

## 1. Create a local runtime and sandbox project

In the setup terminal, start Bash and keep this shell open for the remaining commands. The
temporary directory holds secrets outside the checkout; files created under this `umask` are
readable only by you. Save its printed path for the server terminal.

```sh
bash
set -euo pipefail
umask 077
STRIPE_QUICKSTART_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quotum-stripe.XXXXXX")"
export STRIPE_QUICKSTART_DIR
printf '%s\n' "$STRIPE_QUICKSTART_DIR"

cat > "$STRIPE_QUICKSTART_DIR/runtime.env" <<EOF
POSTGRES_URI=postgres://postgres:postgres@127.0.0.1:55432/quotum
BILLING_ENV=development
QUOTUM_CONSOLE_ENABLED=false
BILLING_AUTH_MODE=api_key
PORT=3010
QUOTUM_ACTOR=stripe-quickstart
QUOTUM_AUTH_SECRET=$(openssl rand -hex 32)
QUOTUM_SECRETS_KEY_ID=stripe-quickstart
QUOTUM_SECRETS_KEY_BASE64=$(openssl rand -base64 32)
BILLING_OPERATOR_API_KEY=$(openssl rand -hex 32)
EOF
set -a
source "$STRIPE_QUICKSTART_DIR/runtime.env"
set +a

bun install --frozen-lockfile
docker run -d --name quotum-stripe-postgres -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=quotum postgres:18-alpine
until docker exec quotum-stripe-postgres pg_isready -U postgres -d quotum; do sleep 1; done
bun --no-env-file src/migrate.ts

BILLING_PLATFORM_BOOTSTRAP_JSON="$(cat examples/quickstart/platform.json)" \
  bun --no-env-file src/platform-bootstrap.ts --apply \
  --credentials-out "$STRIPE_QUICKSTART_DIR/credentials.json"
TOKEN="$(jq -er '.credentials[] | select(.projectInstanceKey=="acme") | .credential' \
  "$STRIPE_QUICKSTART_DIR/credentials.json")"
export TOKEN
```

This reuses only the demo's topology manifest: `acme` is a sandbox instance with an `sqpk_`
credential. The `BILLING_ENV` setting describes the service process; the instance's `sandbox`
environment selects Stripe test mode. The encryption key must stay the same for every command and
the server that opens this database.

In the **server terminal**, set the directory to the path printed above, load the same settings,
and start the normal entrypoint:

```sh
export STRIPE_QUICKSTART_DIR=/absolute/path/printed/above
set -a
source "$STRIPE_QUICKSTART_DIR/runtime.env"
set +a
bun --no-env-file src/index.ts
```

Back in the setup terminal:

```sh
curl --fail-with-body -sS http://localhost:3010/ready | jq -e '.status == "ok"'
```

Readiness confirms database/schema health. The payment checks come later.

## 2. Create the Stripe product and price

Log the Stripe CLI into the target sandbox, using a separate CLI profile for this walkthrough.
Check the account shown during authorization against the sandbox open in the Dashboard. An
exported `STRIPE_API_KEY` overrides the selected CLI profile; unset it in these terminals first.

```sh
unset STRIPE_API_KEY
stripe login --project-name quotum-quickstart
stripe products create --project-name quotum-quickstart \
  --name "Quotum quickstart: 10 credits" > "$STRIPE_QUICKSTART_DIR/product.json"
STRIPE_PRODUCT_ID="$(jq -er 'select(.livemode == false) | .id' "$STRIPE_QUICKSTART_DIR/product.json")"
stripe prices create --project-name quotum-quickstart \
  --product "$STRIPE_PRODUCT_ID" --currency usd --unit-amount 1000 \
  > "$STRIPE_QUICKSTART_DIR/price.json"
STRIPE_PRICE_ID="$(jq -er 'select(.livemode == false) | .id' "$STRIPE_QUICKSTART_DIR/price.json")"
```

This creates a one-time USD 10.00 price. If you already have an active sandbox product with an
active, fixed, one-time price, set `STRIPE_PRODUCT_ID` and `STRIPE_PRICE_ID` to those IDs instead
of running the create commands. Quotum adoption reads these objects; it does not create them.

## 3. Prepare the restricted key and webhook secret

In the same sandbox's Stripe Dashboard, create a restricted `rk_test_` key using the
[manual restricted-key recipe](providers.md#manual-stripe-restricted-key-recipe). Follow the full
recipe even though this walkthrough buys only a top-up: connection validation checks the billing
adapter's permissions. Events: Read is required for the production setup-event check; Refunds:
Write is optional. Quotum rejects standard `sk_test_` keys for manual connections.

The CLI login is used to provision objects and forward events. The separately created restricted
key is the credential Quotum stores and uses for its API calls.

In the **event-forwarding terminal**, run:

```sh
unset STRIPE_API_KEY
stripe listen --project-name quotum-quickstart \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired \
  --forward-to http://localhost:3010/v1/projects/acme/webhooks/stripe
```

Keep the listener running and copy its `whsec_` secret. This local flow uses Stripe CLI forwarding,
so it needs neither a public tunnel nor a Dashboard webhook endpoint. A Dashboard endpoint has a
different signing secret. See [Stripe's local webhook testing](https://docs.stripe.com/webhooks#test-your-handler).
The four events above cover this Checkout example; production subscriptions and refunds need the
additional events described below.

Back in the **setup terminal**, enter the two secrets at hidden prompts. They are passed to `jq`
through stdin, rather than as command arguments, and written to an owner-only file:

```sh
read -r -s -p 'Restricted rk_test_ key: ' STRIPE_RESTRICTED_KEY; printf '\n'
read -r -s -p 'Listener whsec_ secret: ' STRIPE_WEBHOOK_SECRET; printf '\n'
printf '%s\n%s\n' "$STRIPE_RESTRICTED_KEY" "$STRIPE_WEBHOOK_SECRET" \
  | jq -Rn '{secretKey: input, webhookSecret: input}' \
  > "$STRIPE_QUICKSTART_DIR/stripe-secrets.json"
unset STRIPE_RESTRICTED_KEY STRIPE_WEBHOOK_SECRET

cat > "$STRIPE_QUICKSTART_DIR/stripe-settings.json" <<'JSON'
{
  "checkoutSuccessUrl": "https://example.com/?session_id={CHECKOUT_SESSION_ID}",
  "checkoutCancelUrl": "https://example.com/",
  "portalReturnUrl": "https://example.com/",
  "taxMode": "disabled"
}
JSON
```

The return URLs are HTTPS placeholders that land on Example Domain. Substitute your own HTTPS
application URLs when integrating a frontend. Quotum requires HTTPS even for sandbox connection
settings. Payment fulfillment comes from the signed event, independently of the return page.

## 4. Draft, validate and commit the connection

```sh
bun run quotum connections draft acme stripe \
  --settings "$STRIPE_QUICKSTART_DIR/stripe-settings.json" \
  --secrets-file "$STRIPE_QUICKSTART_DIR/stripe-secrets.json" \
  > "$STRIPE_QUICKSTART_DIR/draft.json"
DRAFT_ID="$(jq -er .draftId "$STRIPE_QUICKSTART_DIR/draft.json")"
bun run quotum connections validate acme stripe "$DRAFT_ID"
bun run quotum connections commit acme stripe "$DRAFT_ID"
bun run quotum connections list acme
```

Check that the Stripe connection is enabled with an `activeVersionId`. Validation reports missing
permissions in `checks` and `missingPermissions`; inspect any `unverifiedPermissions` in the
Dashboard. Failed permission-probe requests in Stripe's request log are expected: the probes use
invalid requests to test write access without creating objects. Commit validates again.

Sandbox commit does not require a setup event. It also does not prove delivery; the paid Checkout
and balance check below do. If you replace the key or listener secret, create and commit a new
draft with the updated secrets before continuing.

## 5. Adopt the real binding and publish the catalog

```sh
jq -n --arg product "$STRIPE_PRODUCT_ID" --arg price "$STRIPE_PRICE_ID" '{
  provider: "stripe",
  productKey: "credits_10",
  name: "10 AI credits",
  kind: "topup",
  entitlementKey: "ai_credits",
  credits: 10,
  externalProductId: $product,
  externalPriceId: $price
}' > "$STRIPE_QUICKSTART_DIR/binding.json"

bun run quotum catalog bindings adopt "$STRIPE_QUICKSTART_DIR/binding.json" --instance acme
bun run quotum catalog bindings list --instance acme
bun run quotum catalog diff examples/quickstart/catalog.json --instance acme
bun run quotum catalog push examples/quickstart/catalog.json --instance acme
```

Review the diff before pushing. On this fresh database publication produces revision 1. This
reuses the starter catalog's logical `credits_10` binding with the real Stripe IDs just adopted;
do not run the fake demo's `catalog:provision` import. Adoption verifies the product, price and
environment through the committed connection. The catalog defines ten `ai_credits` per purchase
and one credit per `api_calls` unit. Repeating the same adoption or catalog push is safe.

## 6. Pay through Checkout and verify the grant

```sh
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
curl --fail-with-body -sS -X PUT http://localhost:3010/v1/billing-accounts/stripe_quickstart \
  "${AUTH[@]}" -d '{}' | jq .data
curl --fail-with-body -sS -X POST \
  http://localhost:3010/v1/billing-accounts/stripe_quickstart/providers/stripe/checkout-sessions \
  "${AUTH[@]}" -H 'Idempotency-Key: stripe-quickstart-checkout-1' \
  -d '{"productKey":"credits_10","email":"stripe-quickstart@example.com"}' \
  > "$STRIPE_QUICKSTART_DIR/checkout.json"
jq -er .data.url "$STRIPE_QUICKSTART_DIR/checkout.json"
SESSION_ID="$(jq -er .data.sessionId "$STRIPE_QUICKSTART_DIR/checkout.json")"
```

Open the printed URL in a browser. Complete the sandbox Checkout with Stripe's test card
`4242 4242 4242 4242`, a future expiry date and any three-digit CVC. See
[Stripe's test-card guide](https://docs.stripe.com/testing#cards). Wait for the forwarding terminal
to show `checkout.session.completed` delivered with HTTP 200.

Back in the setup terminal, check both Stripe session state and Quotum's balance:

```sh
curl --fail-with-body -sS \
  "http://localhost:3010/v1/billing-accounts/stripe_quickstart/providers/stripe/checkout-sessions/$SESSION_ID" \
  "${AUTH[@]}" | jq '.data | {status, paymentStatus}'
# {"status":"complete","paymentStatus":"paid"}

curl --fail-with-body -sS \
  http://localhost:3010/v1/billing-accounts/stripe_quickstart/balances/ai_credits \
  "${AUTH[@]}" | jq '.data | {granted, consumed, available}'
# {"granted":"10","consumed":"0","available":"10"}
```

The session read never grants credits. The balance is the fulfillment check; if delivery is still
processing, repeat the balance read. Use the Checkout created above: a generic `stripe trigger`
fixture lacks this account's Quotum checkout correlation.

## 7. Consume credits and replay safely

```sh
curl --fail-with-body -sS -X POST \
  http://localhost:3010/v1/billing-accounts/stripe_quickstart/usage/consume \
  "${AUTH[@]}" -H 'Idempotency-Key: stripe-quickstart-consume-1' \
  -d '{"featureId":"api_calls","value":"3"}' \
  | jq -e '.data | select(.allowed == true) | .balance | {granted, consumed, available}'
# {"granted":"10","consumed":"3","available":"7"}
```

Repeat that exact request. It returns the same receipt and leaves seven credits. Reusing the key
with a different body returns `409 IDEMPOTENCY_CONFLICT`. The walkthrough is complete when a paid
Stripe session has produced ten credits, three have been consumed, and replay has not consumed
three more. Signed projection delivery to your application is a separate integration; configure
its receiver using the [projection guide](providers.md#projections).

## When a step fails

| Symptom | Check |
| --- | --- |
| `INVALID_CONNECTION` or `STRIPE_CONNECTION_INVALID` | Use an `rk_test_` key and the full permission recipe; inspect the returned checks. |
| `STRIPE_BINDING_INVALID` | The product and price must be active, in the key's sandbox, with the price belonging to that product. A top-up needs a positive fixed one-time price. |
| `STRIPE_WEBHOOK_SIGNATURE_INVALID` | Store the current listener's signing secret, commit the connection, and check the destination contains `acme`. |
| Paid session but no credits | Check listener delivery and response, the selected Stripe sandbox, and service logs. A successful browser redirect alone does not fulfill a payment. If delivery was missed, replay the actual signed event through a configured endpoint; do not post the fake demo's event. |
| Existing mapping conflicts with the new IDs | Use the fresh database from step 1. Adoption deliberately does not replace an existing product identity. |

## Moving to production

A successful sandbox run proves the integration path for that sandbox. Production has its own
instance, catalog, products/prices, key and endpoint secret. Configure those on the deployed normal
runtime using [self-hosting](self-hosting.md) and [headless connection setup](providers.md#headless-connection-setup):

1. Create or select the production instance and its live products/prices. Both project environments
   are active from onboarding; credential issuance is independent of connection readiness.
2. Create an `rk_live_` key with the permission recipe, including **Events: Read**, and a persistent
   public HTTPS Stripe webhook endpoint. Use that endpoint's signing secret for the connection.
   Select snapshot events for your account. Include the four Checkout events above plus
   `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.trial_will_end`, `refund.created`, `refund.updated`, `refund.failed`,
   `charge.refunded` and `charge.dispute.created` for the supported subscription/refund lifecycle.
3. Draft and validate the live connection, then change the endpoint URL to the returned
   `setupWebhookPath` on your public origin. Select `product.updated` temporarily and edit metadata
   on a product in that live account **after drafting**. This produces a real event without a
   payment. Commit with `--wait-for-event 10m`. Quotum verifies the event using the connection's own
   key; it must be no more than five minutes old. Resending an old event does not make it fresh.
4. After commit, change the **same endpoint's URL** to
   `/v1/projects/<production-instance>/webhooks/stripe`, preserving its signing secret. Remove the
   temporary `product.updated` subscription. Adopt the live bindings and publish the production
   catalog before sending customers to Checkout.
5. Verify actual delivery and the resulting billing state. `quotum environments readiness` is
   informational; neither it nor the sandbox test proves the production endpoint works.

The [setup-event diagnostics](providers.md#if-a-setup-event-is-refused) explain account, mode,
permission and freshness failures. Keep the setup and regular webhook destinations distinct:
the setup receiver verifies the draft; it does not fulfill purchases.

## Clean up this walkthrough

Stop the forwarding process and Quotum server with Ctrl-C. Archive the product and price created
for this walkthrough in the sandbox Dashboard and revoke its temporary restricted key. Keep any
pre-existing objects you chose to reuse. Remove the disposable local database and temporary files:

```sh
docker rm -f quotum-stripe-postgres
rm -r -- "$STRIPE_QUICKSTART_DIR"
unset TOKEN AUTH STRIPE_QUICKSTART_DIR QUOTUM_AUTH_SECRET QUOTUM_SECRETS_KEY_BASE64 BILLING_OPERATOR_API_KEY
```

Keep the encryption/auth keys in a secret store instead if you intend to retain the database.
