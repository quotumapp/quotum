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

Subscription changes are queued with
`POST /v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes`; upgrades and
quantity changes apply immediately by default, downgrades at period end. Base and licensed prices
are Checkout line items; metered overage is invoiced by the recurring billing worker after the period
closes. Add-ons use a separate subscription and require an active base plan.

Refunds and disputes reverse credits proportionally to the cumulative reversed amount and are
deduplicated by refund id. Configure Stripe to send `refund.created` and `refund.updated`;
`charge.refunded` is safely ignored.

Regular provider webhooks use `/v1/projects/:projectKey/webhooks/:provider`. Connection setup also
exposes the version-specific route
`/v1/projects/:projectKey/connections/:versionId/webhooks/:provider` to verify the draft connection.
Stripe App OAuth events instead use `/v1/stripe-app/webhooks/test` or `/v1/stripe-app/webhooks/live`
when OAuth is enabled. These signed app-level events resolve the connection by Stripe account and
mode; they are not addressed by a project key.

## Projections

Quotum never writes your database. It delivers signed HTTP `billing_state_v1` projections with
the entitlement and exact-string balance snapshot to the connection's projection URL, retrying
with backoff. Verify `X-Billing-Signature` and `X-Billing-Timestamp`, apply idempotently by
`idempotencyKey`, and treat the projection as a read model: authorization decisions must use the
metering API.

Purchase, provider-webhook and reconciliation projections are delivered per event. Usage-driven
projections are coalesced: one delivery per billing account covers every consume, reservation and
confirmation since the previous one, is sent after the project's debounce
(`metering_settings.projection_usage_debounce_ms`, default one second), and carries the state
current at delivery, so a receiver sees fewer deliveries than usage calls. Every payload includes a
per-account `sequence`; a receiver that already applied a higher sequence for the account may
discard the snapshot but should still record any `purchase` or `reversal` facts by their key. Set
`usageDelivery` to `off` on the projection connection when your backend takes balances from the
consume response and only needs purchase and provider events.
