# Provider integrations

- Document kind: Current behavior

Connections are configured per project environment in the merchant application under
**Integrations**. The fields below describe supported connection inputs; credentials are submitted
through write-only secret fields. The selected project environment determines sandbox or production
mode.

Store product mappings must already exist before a catalog binding can adopt them. Their provisioning
is an operator prerequisite: the merchant catalog editor does not create `products` or `store_products`
rows. The development import (`bun run catalog:provision`) currently creates Stripe/web mappings only
and skips instances with a published catalog. Apple/iOS and Google/Android mappings require separate
operator provisioning; there is no native-store provisioning command in the current service.

## Provider capabilities

The table below states which billing operations each declared provider supports, under which
conditions, and which tests verify them. `bun run openapi:generate` renders it and
[`contracts/v1/provider-capabilities.json`](../contracts/v1/provider-capabilities.json) from the
capability declarations under `src/providers/`, and `bun run openapi:check` fails when either is
stale.

Catalog preview and publish check every binding of a new intent against these declarations after
its structural checks, and reject all incompatible bindings together with one
`400 PROVIDER_CAPABILITY_UNSUPPORTED`; see
[Provider capability errors](api.md#provider-capability-errors).

The table shows the declarations alone. The capability reads and environment readiness also require
a validated connection for every operation and, outside recovery work such as webhook ingestion, an
enabled one. Requests do not evaluate these connection conditions: a request that reaches a
provider without a usable connection fails with `BILLING_PROVIDER_NOT_CONFIGURED`, and catalog
publish does not look at connections. `GET /v1/admin/providers/capabilities` evaluates the
declarations against an environment's persisted connections, and
`GET /v1/billing-accounts/:billingAccountId/available-actions` against one billing account and its
live subscriptions. Environment readiness adds non-gating `blockerDetails` for catalog bindings the
connections cannot serve. See
[Provider capabilities and available actions](api.md#provider-capabilities-and-available-actions).

<!-- provider-capabilities:start -->
<!-- Generated from contracts/v1/provider-capabilities.json by bun run openapi:generate; do not edit. -->

| Operation | Apple | Google | Stripe | Paddle (planned) |
| --- | --- | --- | --- | --- |
| **Catalog** | | | | |
| Subscription products<br>`catalog.product.subscription` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | Planned · Native<br>Questions: Q-CHK-01 |
| Consumable products<br>`catalog.product.consumable` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Requires policy decision (DEC-14) · Native<br>Questions: Q-ELIG-03 |
| Non-consumable products<br>`catalog.product.non_consumable` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-CHK-03 |
| Trials<br>`catalog.trial` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-SUB-06 |
| Add-on plans<br>`catalog.addon` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | Conditional; not implemented · Native<br>All recurring prices must share one billing interval.<br>Questions: Q-SUB-04 |
| Top-up options<br>`catalog.topup` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Requires policy decision (DEC-14) · Native<br>Questions: Q-ELIG-03 |
| Flat price components<br>`catalog.price.flat` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native |
| Licensed-quantity prices<br>`catalog.price.licensed` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional; not implemented · Native<br>Quantities must be whole numbers.<br>Questions: Q-SUB-05 |
| Tiered prices<br>`catalog.price.tiered` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts), [billing/commercial-pricing](../tests/billing/commercial-pricing.test.ts) | Not evaluated |
| Hybrid prices<br>`catalog.price.hybrid` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Conditional; not implemented · Native<br>All recurring prices must share one billing interval.<br>Questions: Q-SUB-04 |
| Postpaid usage prices<br>`catalog.price.postpaid_usage` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts) | Requires policy decision (DEC-14) · Quotum-composed via non-catalog transaction item<br>Questions: Q-SET-01, Q-SET-03, Q-TAX-01 |
| **Checkout** | | | | |
| Hosted product checkout<br>`checkout.hosted` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-ELIG-02, Q-ELIG-05, Q-CHK-02, Q-CHK-03, Q-RET-01 |
| Hosted plan checkout<br>`checkout.plan` | Unsupported | Unsupported | Supported · Native<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-ELIG-02, Q-CHK-01, Q-CHK-02, Q-RET-01 |
| **Purchase verification** | | | | |
| Purchase verification<br>`purchase.verify` | Supported · Native<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts), [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts), [integration/google-flows](../tests/integration/google-flows.test.ts) | Unsupported | Not evaluated |
| **Customer portal** | | | | |
| Customer portal session<br>`portal.session` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-PORT-01 |
| **Events and reconciliation** | | | | |
| Webhook ingestion<br>`webhook.ingest` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/service](../tests/providers/apple/service.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts), [providers/google/service](../tests/providers/google/service.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-WH-01, Q-WH-02, Q-WH-03 |
| Stored event replay<br>`event.replay` | Supported · Native<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts) | Supported · Native<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts) | Supported · Native<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-WH-03 |
| Subscription reconciliation<br>`subscription.reconcile` | Supported · Native<br>Tests: [providers/apple/service](../tests/providers/apple/service.test.ts) | Supported · Native<br>Tests: [providers/google/service](../tests/providers/google/service.test.ts), [integration/worker-flows](../tests/integration/worker-flows.test.ts) | Supported · Native<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts) | Planned · Native<br>Questions: Q-RET-02, Q-RATE-01 |
| **Subscription changes** | | | | |
| Subscription change preview<br>`subscription.change.preview` | Unsupported | Unsupported | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Not evaluated<br>Questions: Q-SUB-07 |
| Immediate subscription change<br>`subscription.change.apply` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [integration/promotions](../tests/integration/promotions.test.ts), [workers/recurring-billing](../tests/workers/recurring-billing.test.ts) | Planned · Native<br>Questions: Q-SUB-01, Q-SUB-03, Q-RET-01 |
| Period-end subscription change<br>`subscription.change.period_end` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [billing/pricing](../tests/billing/pricing.test.ts) | Requires semantic validation (Q-SUB-02) · Native<br>Questions: Q-SUB-01, Q-SUB-02 |
| Subscription cancellation<br>`subscription.cancel` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/commercial-cancellation](../tests/providers/stripe/commercial-cancellation.test.ts) | Planned · Native<br>Questions: Q-SUB-01 |
| Subscription uncancellation<br>`subscription.uncancel` | Managed by provider, mirrored by Quotum | Managed by provider, mirrored by Quotum | Conditional · Native<br>The subscription state must be active, grace_period, billing_retry or cancelled.<br>The subscription must have a cancellation pending at its period end.<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/commercial-cancellation](../tests/providers/stripe/commercial-cancellation.test.ts) | Not evaluated<br>Questions: Q-SUB-01 |
| **Usage settlement** | | | | |
| Postpaid usage collection<br>`settlement.collect_finalized_charge` | Unsupported | Unsupported | Supported · Quotum-composed via Stripe invoices with a one-off usage line<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [workers/recurring-billing](../tests/workers/recurring-billing.test.ts), [integration/catalog-control-plane](../tests/integration/catalog-control-plane.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | Requires policy decision (DEC-14) · Quotum-composed via one-time subscription charge<br>The operation is unavailable during the 30 minutes before the next renewal.<br>The subscription state must be active.<br>Questions: Q-SET-02, Q-SET-03, Q-TAX-01, Q-RET-01, Q-RET-02, Q-RATE-02 |
| Usage adjustment<br>`adjustment.issue` | Unsupported | Unsupported | Supported · Quotum-composed via Stripe invoices with a signed correction line<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | Requires policy decision (DEC-14) · Quotum-composed via transaction adjustment<br>Questions: Q-REF-01, Q-REF-02, Q-SET-03, Q-RET-01 |
| **Refunds** | | | | |
| Refund and reversal sync<br>`refund.sync` | Managed by provider, mirrored by Quotum<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts), [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts) | Managed by provider, mirrored by Quotum<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts), [providers/google/service](../tests/providers/google/service.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts), [providers/stripe/service](../tests/providers/stripe/service.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | Planned · Native<br>Questions: Q-REF-01 |
| **Top-ups** | | | | |
| Customer-initiated top-up<br>`topup.customer_initiated` | Supported · Native<br>Tests: [integration/apple-flows](../tests/integration/apple-flows.test.ts) | Supported · Native<br>Tests: [integration/google-flows](../tests/integration/google-flows.test.ts) | Supported · Native<br>Tests: [integration/stripe-flows](../tests/integration/stripe-flows.test.ts) | Requires policy decision (DEC-14) · Native<br>Questions: Q-ELIG-03, Q-CHK-03 |
| Automatic top-up<br>`topup.automatic` | Unsupported | Unsupported | Conditional · Quotum-composed via Stripe invoices with a top-up price line<br>The customer must have a saved payment method; without one, use topup.customer_initiated.<br>Tests: [providers/stripe/service](../tests/providers/stripe/service.test.ts), [workers/auto-topup](../tests/workers/auto-topup.test.ts), [integration/phase3-release-journeys](../tests/integration/phase3-release-journeys.test.ts) | Requires policy decision (DEC-14) · Quotum-composed via one-time subscription charge<br>The connection setting "spmConsent" must be true.<br>The customer must have a saved payment method; without one, use topup.customer_initiated.<br>The operation is unavailable during the 30 minutes before the next renewal.<br>The subscription state must be active.<br>Questions: Q-SET-02, Q-SET-04, Q-ELIG-03, Q-RET-01, Q-RET-02, Q-RATE-02 |
| **Promotions** | | | | |
| Promotion code applied by Quotum<br>`promotion.code_entry` | Not evaluated | Not evaluated | Supported · Quotum-composed via Stripe coupons applied as Checkout and subscription discounts<br>Tests: [integration/promotions](../tests/integration/promotions.test.ts), [providers/stripe/promotions](../tests/providers/stripe/promotions.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | Requires semantic validation (Q-PROMO-01) · Native<br>Questions: Q-PROMO-01 |
| Hosted promotion code entry<br>`promotion.hosted_code` | Not evaluated | Not evaluated | Supported · Native<br>Tests: [integration/promotions](../tests/integration/promotions.test.ts), [providers/stripe/promotions](../tests/providers/stripe/promotions.test.ts), [providers/stripe/normalizer](../tests/providers/stripe/normalizer.test.ts) | Requires semantic validation (Q-PROMO-01) · Native<br>Questions: Q-PROMO-01, Q-PROMO-02 |

Statuses:

- **Supported**: Level is native or quotum_composed, verification is verified, and no conditions are declared.
- **Conditional**: Level is native or quotum_composed, and verification is conditional or verified with at least one condition.
- **Conditional; not implemented**: Level is native or quotum_composed, verification is planned without a blocker, and at least one condition is declared.
- **Planned**: Level is native or quotum_composed, verification is planned without a blocker, and no conditions are declared.
- **Requires policy decision**: Level is native or quotum_composed, and verification is planned with a decision blocker.
- **Requires semantic validation**: Level is native or quotum_composed, and verification is planned with a scenario or question blocker.
- **Managed by provider**: Level is provider_managed, whatever the verification.
- **Unsupported**: Level is unsupported.
- **Not evaluated**: Level is not_evaluated.

Support kinds: Native; Quotum-composed; Managed by provider, mirrored by Quotum; Unsupported; Not evaluated. A Quotum-composed cell names the provider primitive Quotum builds the operation on.

Tests link to the repository tests that exercise the declared behavior. Scenario ids name conformance scenarios; question ids and decision ids name provider assessment questions and decision register entries in the Quotum documentation repository.

Planned providers and planned statuses come from a dated provider assessment in the Quotum documentation repository and are not commitments. Provider-layer sources are cited in that assessment and are not linked from this guide.
<!-- provider-capabilities:end -->

## Apple StoreKit

- `apple.bundleId`, `apple.appAppleId` (numeric app id, required in production).
- `apple.issuerId`, `apple.keyId`, and the write-only `apple.privateKey` from the App Store Connect
  In-App Purchase key. Validation requires an EC P-256 private key.

Connection setup derives `apple.environment` from the selected environment, enforces online checks
in both modes, and uses the committed public Apple PKI roots in `src/providers/apple/certs/`.
Self-service does not expose a certificate-directory override. Production retries sandbox verification
only for signed payloads Apple rejects with an explicit environment mismatch.

Client flow:

1. The trusted backend calls `GET /v1/billing-accounts/:billingAccountId/providers/apple/account-token`
   and returns the UUID to the iOS app.
2. The app passes it as StoreKit 2 `appAccountToken` when purchasing and sends the completed
   transaction id to the backend.
3. The backend calls `POST /v1/purchases/verify` with `provider="apple"`, `billingAccountId`, and
   `transactionId`. Quotum verifies with Apple, requires the transaction's token to match the
   customer, records state, enqueues projection sync, and returns the entitlement snapshot.

Configure App Store Server Notifications V2 to
`https://<billing-host>/v1/projects/<projectKey>/webhooks/apple`. Notification types that do not
change entitlements (`TEST`, `REFUND_DECLINED`, `CONSUMPTION_REQUEST`, renewal-extension summaries,
external purchase token events, Advanced Commerce metadata) are acknowledged without durable writes.

## Google Play Billing

- `googlePlay.packageName`.
- Write-only `googlePlay.serviceAccountJson` with Android Publisher API access. Key-file paths are
  not supported by the self-service connection flow.
- Write-only `googlePlay.obfuscatedAccountIdSecret` for non-PII account ids. Self-service stores one
  current secret and does not support previous-secret overlap during rotation.
- `googlePlay.rtdnAudience`, `googlePlay.rtdnServiceAccountEmail`, `googlePlay.rtdnAuthorizedParty`,
  all required for authenticated Pub/Sub push.
- `googlePlay.enablePublisherMutations`: acknowledge and consume purchases after state is durably
  recorded.

Client flow:

1. The trusted backend calls `GET /v1/billing-accounts/:billingAccountId/providers/google/account-link`
   and returns `obfuscatedAccountId` to the Android app.
2. The app passes it with `setObfuscatedAccountId` and sends the purchase token, purchase kind, and
   product id to the backend.
3. The backend calls `POST /v1/purchases/verify` with `provider="google"`. Quotum verifies the token,
   records state, acknowledges or consumes when required, enqueues projection sync, and returns the
   entitlement snapshot.

Configure the Real-time Developer Notifications push subscription to
`https://<billing-host>/v1/projects/<projectKey>/webhooks/google`. Quotum verifies the Pub/Sub OIDC
token issuer, audience, authorized party, service-account email, and expiry. Voided purchases use a
stable `google:voided:<purchaseToken>:<eventTimeMillis>:...` event id.

## Stripe

- For a restricted-key connection, write-only `stripe.secretKey` (`rk_test_` for sandbox or
  `rk_live_` for production) and `stripe.webhookSecret`.
- `stripe.checkoutSuccessUrl` (must contain `{CHECKOUT_SESSION_ID}`), `stripe.checkoutCancelUrl`,
  `stripe.portalReturnUrl`, and `stripe.allowedReturnOrigins` for request-level overrides.
- `stripe.taxMode`: `disabled`, `test`, or `registered`.
- `stripe.integrationIdentifier` (defaults to `qfmxzjpa`).

When the deployment enables Stripe Apps OAuth, merchants can authorize the Stripe App defined in
[`stripe-app/stripe-app.example.json`](../stripe-app/stripe-app.example.json) instead of entering a
restricted key. OAuth tokens are encrypted per connection; the app's event signing secrets are
configured by the service operator.

Promotions need write access to Coupons and Promotion codes: grant both on a restricted key, or
approve the app version that requests `coupon_write` and `promotion_code_write`. The promotion
maintenance worker creates one coupon per discount promotion and product set, with id
`quotum_<object id>`, and a Stripe promotion code for each code marked `hostedCheckoutEnabled`.
It deactivates the Stripe code when Quotum's code is deactivated, archived, or exhausted. A changed
plan version that alters the discounted Stripe products gets a new coupon; hosted codes are
recreated on it. Objects that Stripe rejects stay `failed` with the error on
`GET /v1/admin/promotions/:promotionKey`; fix the cause and call
`POST /v1/admin/promotions/:promotionKey/provider-sync`. Stripe requires active promotion codes to
be unique in the account, so a code created in the Stripe Dashboard blocks the hosted copy.

Checkout flow:

1. The backend reads `GET /v1/catalog?provider=stripe&channel=web` and calls
   `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions` with exactly
   one `productKey` or `planKey`, licensed `quantities` for a plan, optional `email`, redirect
   overrides, an optional `expiresAt` (Unix seconds, within Stripe's 30-minute to 24-hour window),
   and an `Idempotency-Key`. The response is `{sessionId,url,duplicate}`.
2. The frontend redirects the user to Stripe.
3. Stripe posts signed events to the connection's webhook route (below); Quotum verifies
   `stripe-signature`, records paid subscription or credit-pack state, and enqueues projection sync.
4. Success pages may poll `GET .../providers/stripe/checkout-sessions/:sessionId`, which returns
   `{sessionId,status,paymentStatus,customerEmail,productKey}`; email and product key appear only
   once paid, and the endpoint never grants access. `POST .../checkout-sessions/:sessionId/expire`
   expires open sessions.

Portal sessions come from `POST .../providers/stripe/portal-sessions` and return `{url}`.

For an existing subscription, invoice webhooks record payment history and may update its payment
status, but cannot replace its product, price, purchased items, plan version, period, or subscription
event ordering. Those commercial fields come from subscription events and reconciliation reads.
Paying an older invoice or a proration credit therefore cannot undo an upgrade. Invoice history
retains its own event order, including invoices delivered after newer subscription events.


Subscription changes are queued with
`POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes`; upgrades and
quantity changes apply immediately by default, downgrades at period end. Base and licensed prices
are Checkout line items; metered overage is invoiced by the recurring billing worker after the period
closes. Add-ons use a separate subscription and require an active base plan.

Refunds and disputes reverse credits proportionally to the cumulative reversed amount paid and are
deduplicated by refund id. Configure Stripe to send `refund.created` and `refund.updated`;
`charge.refunded` is safely ignored. For promotion codes, also send `checkout.session.expired` and
`checkout.session.async_payment_failed` so reserved uses are released promptly; the promotion
maintenance worker releases them an hour after the session could have completed otherwise.

Regular provider webhooks use `/v1/projects/:projectKey/webhooks/:provider`. Connection setup also
exposes the version-specific route
`/v1/projects/:projectKey/connections/:versionId/webhooks/:provider` to verify the draft connection.
Stripe App OAuth events instead use `/v1/stripe-app/webhooks/test` or `/v1/stripe-app/webhooks/live`
when OAuth is enabled. These signed app-level events resolve the connection by Stripe account and
mode; they are not addressed by a project key.

## Projections

Quotum never writes your database. It delivers signed HTTP `billing_state_v1` projections with
the entitlement and exact-string balance snapshot to the connection's projection URL, retrying
with backoff. Verify `X-Billing-Signature` and `X-Billing-Timestamp`, and treat the projection as a
read model: authorization decisions must use the metering API. Order snapshots per billing account
by `sequence`, and record `purchase` and `reversal` facts idempotently by their key.
`idempotencyKey` identifies the job, not a delivery: retries resend it, and every usage-driven
delivery for an account reuses one key, so discarding a payload whose key was already seen drops
newer usage snapshots. [`scripts/projection-receiver.ts`](../scripts/projection-receiver.ts) is a
reference receiver.

Each entitlement's `metadata` names its source. A subscription source carries `status`,
`provider`, `channel`, `productId` and `storeProductId`, plus `trialStartsAt` and `trialEndsAt`
(UTC ISO timestamps) when the subscription has a trial. A trialing Stripe subscription reports
`status: "active"`, and both bounds stay after the trial ends, so treat the subscription as
trialing while `trialEndsAt` is in the future. Apple and Google run trials as store offers that
Quotum does not record yet, so their entitlements carry no trial bounds.

Purchase, provider-webhook and reconciliation projections are delivered per event. Usage-driven
projections are coalesced: one delivery per billing account covers every consume, reservation and
confirmation since the previous one, is sent after the project's debounce
(`metering_settings.projection_usage_debounce_ms`, default one second), and carries the state
current at delivery, so a receiver sees fewer deliveries than usage calls. Payloads carry a
per-account `sequence`; a receiver that already applied a higher sequence for the account may
discard the snapshot but should still record any `purchase` or `reversal` facts by their key. The
payload schema keeps `sequence` optional; treat a payload without it as unordered and apply it as
current. Set
`usageDelivery` to `off` on the projection connection when your backend takes balances from the
consume response and only needs purchase and provider events.

## Adding a provider

1. Complete a provider assessment from the template in the Quotum documentation repository. It
   records commercial eligibility, checkout, subscription changes, usage settlement, refunds,
   webhooks, retries, idempotency and rate limits, with a dated source for each answer and the
   questions that remain open.
2. Add `src/providers/<provider>/capabilities.ts` and list it in `src/providers/capabilities.ts`.
   Declare every operation, either at `not_evaluated` or at the support level and status the
   assessment sources. Keep `availability: "planned"` until the provider is admitted, which adds
   it to `billingProviders`, the provider CHECK constraints and the Drizzle schema in one change.
   `tests/db/provider-check-constraints.test.ts` fails until the provider CHECK constraints in the
   migrations and their Drizzle `check()` mirrors match the admitted providers; checkout requests
   admit only providers that implement checkout.
   A verified or conditional entry cites a test tagged `// capability: <operation>`.
3. Implement the `ProviderAdapter` groups in `src/providers/contract.ts` that the declaration's
   supported operations require, and add the adapter's entry to `src/providers/registry.ts`. The
   registry refuses to build an adapter that has no method for an operation its declaration marks
   as implemented.
4. Run the conformance suite against the adapter and commit its report. The suite and its reports
   arrive in a later increment; until then, tagged tests are the only accepted evidence.
5. Run `bun run openapi:generate` to regenerate
   [`contracts/v1/provider-capabilities.json`](../contracts/v1/provider-capabilities.json) and the
   table above, then `bun run openapi:check`.
6. Document the connection fields in a section of this guide, next to the existing providers, for
   the connection kind the declaration names.
7. Never add a provider branch to catalog, commercial or worker code: the declarations already
   decide. A catalog accepts a plan trial, an add-on, an explicit price component or a top-up only
   when every bound provider implements the operations that construct requires (`catalog.trial`,
   `catalog.addon`, the `catalog.price.*` operations and `catalog.topup`), and a binding's channel
   must be the one its declaration names. Auto top-up charges the customer itself only for a
   provider that implements `topup.automatic`, and queues a terminal `provider_action_required`
   job for the rest.
   A denied consume offers `purchase_required` for the providers that implement
   `topup.customer_initiated`, and a commercial preview reports the provider whose declaration
   implements that action's operation. Express a provider difference as a declared support level or
   condition instead of a branch.
