# Automated Stripe setup

- Document kind: Current behavior
- Sources: [setup service](../src/composition/stripe-setup/service.ts),
  [CLI](../src/composition/cli/stripe-setup.ts),
  [durable receipts](../src/platform/connections/stripe-setup-store.ts).

`quotum setup stripe` creates or reuses Stripe products, prices and a dedicated webhook endpoint,
validates and commits a Quotum connection, adopts the bindings and publishes your catalog. It works
in a Stripe sandbox or live account and resumes the same setup ID after interruptions.

Completion means configuration and signed webhook delivery were verified. It does **not** mean a
payment was tested: `paymentTest` remains `not_performed`. The command creates an inactive product
without a price and updates its metadata to generate real, nonfinancial `product.updated` events.
It never starts Checkout, collects a payment, creates a customer or charges a card. The
[local quickstart](quickstart.md) remains a separate, synthetic billing demo, and the
[real Stripe sandbox quickstart](stripe-quickstart.md) does each of these steps by hand and ends
with a test payment.

## Prerequisites

Run a migrated Quotum deployment with a public HTTPS origin and a bootstrapped project instance;
see [self-hosting](self-hosting.md). The runtime must be this version, with real database-owned
connections, not the guarded fake test entrypoint. The setup command does not start the server,
Postgres, a tunnel or a projection receiver. Stripe must be able to reach the supplied origin.

Run the CLI with the deployment's `POSTGRES_URI`, `QUOTUM_AUTH_SECRET` and
`QUOTUM_SECRETS_KEY_*` configuration. Its target is the manifest's **instance key**, not a project
API credential. Existing working Stripe connections cannot be replaced by this workflow. One
immutable setup owns each instance; rerunning `prepare` with the same manifest returns that ID,
and a changed manifest is refused. Review the manifest before preparing it.

Create two different restricted keys in the same Stripe account and mode (`rk_test_` for sandbox,
`rk_live_` for production). Standard `sk_` keys are refused.

| Key | Permissions |
| --- | --- |
| Provisioning `setupKey` | Accounts: Read; Products: Write; Prices: Write; Webhook Endpoints: Write. Writes include reads. Product Write is needed even when reusing prices, for the inactive verification product. |
| Billing `runtimeKey` | The complete [manual restricted-key recipe](providers.md#manual-stripe-restricted-key-recipe), plus Events: Read in **both** environments. Products and Prices remain Read; Webhook Endpoints access is unnecessary. |

Keep the provisioning key separate from the runtime key. Only the runtime key and signing secret
are persisted in the encrypted connection. The command runs nonfinancial permission probes;
unverified required runtime writes prevent completion. Revoke the provisioning key after setup if
you no longer need to resume or re-verify, and obtain equivalent access when verification is needed
again. A replacement runtime key requires the ordinary connection-management workflow.

Put the two keys in a private regular JSON file, mode `0600`, using a secret manager or secure
editor. Its shape is `{"setupKey":"rk_…","runtimeKey":"rk_…"}`. Do not put keys in the manifest,
command arguments, chat, source control or logs. Credential files must be at most 64 KB; symlinks
are refused. An optional `webhookSecret` field is used when reusing an endpoint or recovering a
one-time signing secret that could not be saved.

## Prepare, inspect and apply

Copy [examples/stripe-setup.json](../examples/stripe-setup.json) to a private working directory.
Edit its instance key, Stripe account ID, HTTPS public origin, application return URLs, prices and
catalog. The example creates a $10 USD one-time price for 10 AI credits; replace this commercial
choice before applying. `expectedRevision: null` means no catalog has been published. An existing
catalog requires its current revision. Applying publishes exactly the reviewed catalog intent.

```sh
quotum setup stripe prepare ./stripe-setup.json \
  --credentials-file ./stripe-credentials.json --actor you@example.com

# Inspect the returned manifest and setupId before applying.
quotum setup stripe status <setup-id>
quotum setup stripe apply <setup-id> \
  --credentials-file ./stripe-credentials.json --actor you@example.com
```

From a source checkout use `bun run quotum` instead of `quotum`. Member-managed organizations also
require `--member-override-reason <reason>` for writes, as with other operator commands.
`prepare` makes Stripe reads and persists the immutable plan; it performs no Stripe writes.

`apply` advances until it needs webhook delivery. Repeat the same `apply` after Stripe delivers
the event. `status` reads the receipt without Stripe credentials. Exit `0` means prepared or
complete, `2` means pending or requires review, and malformed command inputs exit `64`.

| Status | Meaning and next action |
| --- | --- |
| `prepared` | Inspect the manifest, then apply its ID. |
| `awaiting_setup_event` | A real event must reach the version-specific setup route. Check Stripe delivery results and the public origin, then apply again. |
| `awaiting_delivery_event` | The connection is committed; a second, nonce-correlated event must reach the normal runtime webhook route. Wait for delivery, then apply again. |
| `requires_review` | Inspect `reason`, `currentStep` and the sanitized permission `checks`. Correct permissions, connectivity or the stated blocker, then resume the same ID. |
| `complete` | The active connection, final endpoint settings, signed delivery and published revision were verified. Payment testing remains separate. |

Provisioned resources and steps have durable receipts and stable Stripe idempotency keys. A retry
does not start a second setup. After 23 hours an uncertain provider write is reconciled by its
setup metadata or exact endpoint configuration; absent or ambiguous results require operator
review instead of a new create. Do not remove the `quotum_setup_*` metadata while setup is pending.
An expired connection draft is replaced within the same run, retaining Stripe resource IDs.

Stripe returns a newly created endpoint's signing secret once. Quotum encrypts it before recording
the endpoint receipt. If it cannot recover that value, `webhook_secret_unavailable_supply_from_dashboard`
requires the existing endpoint's signing secret in the protected credentials file. Resume the same
setup ID; do not create a replacement endpoint. Pending encrypted setup secrets participate in
`quotum connections rotate-secrets`; the setup copy is cleared on completion. The committed
connection keeps its encrypted runtime secret.

## Reuse products and a dedicated endpoint

Replace a create binding with a reuse binding, retaining its Quotum identity:

```json
{
  "source": "reuse",
  "productKey": "credits_10",
  "name": "10 AI credits",
  "kind": "topup",
  "entitlementKey": "ai_credits",
  "credits": 10,
  "externalProductId": "prod_REPLACE",
  "externalPriceId": "price_REPLACE"
}
```

Prices must be active, fixed per-unit prices in the selected account/mode, linked to the declared
active product. Subscriptions require licensed recurring prices; top-ups require positive one-time
prices. Create bindings for subscriptions take `interval` and optionally `intervalCount`.

To reuse an endpoint set `webhook` to `{"source":"reuse","endpointId":"we_REPLACE"}` and supply
its `webhookSecret` in the credentials file. The endpoint must be **disabled**, dedicated to this
setup, independent of a Stripe App, and pinned to API version `2026-09-30.endive`. Its URL and event
selection will be changed. Shared or working endpoints must not be repurposed. Stripe does not let
this command change an existing endpoint's API version; create a dedicated one when it differs.

## Production and verification

For a fresh production instance, prepare a separate manifest with `environment: "production"`,
its instance key, the live account ID and live restricted keys. Sandbox IDs, secrets and delivery
receipts cannot be promoted. The same two delivery checks run, including the existing production
connection gate. No live charge is part of this workflow.

The first probe reaches `/v1/projects/<instance>/connections/<version>/webhooks/stripe`. After
connection validation and commit, the endpoint moves to `/v1/projects/<instance>/webhooks/stripe`.
The regular handler checks its signature and the probe observer retrieves the event with the
connection's own key, matching account, mode, product, nonce and freshness. Catalog publication
follows that delivery. Finally, the endpoint retains only the billing events from
[the event selection](../src/composition/stripe-setup/schema.ts); temporary `product.updated`
delivery is removed. The inactive probe product remains available for later verification.

```sh
quotum setup stripe verify <setup-id> \
  --credentials-file ./stripe-credentials.json --actor you@example.com
# Resume the resulting pending verification with apply, not another verify.
quotum setup stripe apply <setup-id> \
  --credentials-file ./stripe-credentials.json --actor you@example.com
```

`verify` starts a fresh nonfinancial delivery probe for a committed setup. It checks the same
manifest and catalog revision; it does not silently replace a changed connection or publish over
a later catalog. Use ordinary connection/catalog operations for those changes.

To qualify billing separately, complete a real Stripe sandbox Checkout through Quotum's
[Checkout API](subscriptions.md) (the request in
[step 6 of the manual walkthrough](stripe-quickstart.md#6-pay-through-checkout-and-verify-the-grant)
works against this setup), confirm that its provider event produces the expected billing
state, and exercise usage through your backend. Projection receiver setup is a separate
[connection](providers.md#headless-connection-setup). This repository's setup integration tests use
real Postgres, connection lifecycle, signature verification and the Stripe SDK with an isolated
HTTP transport; they are not evidence of live Stripe or network qualification.

For an agent-driven run, use the explicitly enabled
[local operator MCP](mcp.md#local-operator-mcp-for-self-hosted-setup): `prepare_stripe_setup` takes
the manifest as JSON and the credentials file by name from its private directory;
`apply_stripe_setup`, `get_stripe_setup` and `verify_stripe_setup` take the setup ID.
