# Promotions

- Document kind: Current behavior

A promotion is an immutable offer with one effect: a `discount` (percent in basis points, or a
fixed amount per currency, lasting `once`, `repeating` for 1-36 months, or `forever`), a
`feature_grant` of consumable feature quantities, or a `plan_grant` of a plan for a number of days
or months. It can target plan or product keys and restrict the channels (`web`, `ios`, `android`)
where a code may be entered. Changing terms means creating a new promotion.

Operators manage promotions with project authentication, `X-Billing-Operator-Key`, and
`X-Billing-Actor` on mutations:

- `POST /v1/admin/promotions` creates a promotion and optional codes. It returns `201`, or `200`
  when the same key is replayed with identical terms; different terms return
  `PROMOTION_KEY_CONFLICT`.
- `GET /v1/admin/promotions` and `GET /v1/admin/promotions/:promotionKey` list and read promotions
  with code and redemption counts.
- `POST /v1/admin/promotions/:promotionKey/codes` adds codes all-or-nothing;
  `GET .../codes` lists them; `POST .../codes/:codeId/deactivate` deactivates one.
- `POST /v1/admin/promotions/:promotionKey/archive` stops new redemptions.
- `GET /v1/admin/promotions/:promotionKey/redemptions` lists the redemption ledger.

Codes use 3-64 letters, digits, or hyphens and are unique per project instance regardless of
case. Each code can set a start and expiry, a global cap, a per-customer cap (one by default,
`null` for unlimited), a first-purchase-only rule, and a billing-account restriction. A code marked
`hostedCheckoutEnabled` cannot carry a per-customer cap or an account restriction.

`POST /v1/billing-accounts/:billingAccountId/promotion-codes/validate` lets the trusted backend
check a code before offering it. It needs only project authentication, never creates a customer
or takes a use, and returns `200` with `valid` and a `reason` such as `PROMOTION_CODE_EXPIRED`,
`PROMOTION_CODE_EXHAUSTED`, `PROMOTION_CODE_ALREADY_REDEEMED`, or
`PROMOTION_CODE_NOT_APPLICABLE` for a `target` the promotion does not cover. Unknown codes and codes
restricted to another account both report `PROMOTION_CODE_NOT_FOUND` without promotion details.
It is rate limited per project and client IP with the purchase-verification limit
(`BILLING_VERIFY_RATE_LIMIT_PER_WINDOW`), counted separately from verification and shared by every
billing account the backend validates codes for; see [rate limits](deployment.md#rate-limits).

Checkout intents (`checkout_plan`, `checkout_product`) accept one discount entry mode:

- `promotionCode`: the backend applies a code it collected. Preview runs the same checks as
  validation and returns `subtotalMinor`, `discountTotalMinor`, the discounted
  `estimatedTotalMinor`, per-line `subtotalMinor`/`discountMinor`/`totalMinor`, the `promotion`
  terms, and for recurring plans a `nextCycle` whose `discountStatus` is `applies` or `ended`.
  Tiered lines stay `provider_calculated`. Execution reserves one use of the code, passes the
  promotion's Stripe coupon to Checkout, and returns `promotionRedemption`; the completed Checkout
  webhook applies the use, and an expired or failed session releases it. A fully refunded purchase
  marks its redemption `reversed` but keeps the use counted.
- `allowPromotionCodes: true`: Stripe shows its own code field. Only codes marked
  `hostedCheckoutEnabled` exist in Stripe; Quotum records their use from the completed Checkout
  webhook, including uses past a cap that Stripe accepted.

Sending both returns `PROMOTION_CODE_ENTRY_CONFLICT`. A promotion without a Stripe coupon yet is
created during execution; if Stripe rejected it, execution returns `PROMOTION_PROVIDER_NOT_READY`.

`subscription_change` intents accept `promotionCode` for the target plan. Proration stays
`provider_calculated`; `nextCycle` shows the discounted renewal, or `provider_calculated` for a
`once` discount. A subscription with a Quotum discount that can still apply rejects another code
with `PROMOTION_STACKING_NOT_ALLOWED`. Execution reserves the use with the queued change. The worker
adds the coupon to the subscription while keeping its existing discounts, applies the use when the
change applies, and releases it when the change fails for good. Metered overage invoices and
automatic top-ups are billed at list price.

`POST /v1/billing-accounts/:billingAccountId/promotion-redemptions` redeems a code outside a
purchase. It needs project authentication, an `Idempotency-Key`, and a body with `code` and the
`channel` where the customer entered it; `X-Billing-Actor` is optional and defaults to the billing
account. A `feature_grant` code takes one use and returns `kind: "granted"` with one reward
allocation per feature. Rewards expire `expiresAfterSeconds` after redemption (at most 315,619,200
seconds, ten years), are spent like any other allocation, and trigger a coalesced `usage_changed` projection. On web and Android a `discount` code takes no use
and returns `kind: "requires_commercial_action"`; pass it as `promotionCode` to a commercial action.
On iOS, discount codes require a linked Apple promotional offer and the existing subscription;
they return a signed StoreKit action, described below. Direct iOS feature or plan grants remain
unsupported (`PROMOTION_CODE_CHANNEL_NOT_SUPPORTED`). Replaying the key returns the stored
result with `duplicate: true`, and reusing it for a different code or channel returns
`IDEMPOTENCY_CONFLICT`. Redemption shares the validation rate limit.
`GET .../promotion-redemptions` and `GET .../promotion-redemptions/:redemptionId` read one
account's ledger.

### Apple subscription offers

Configure the offer in App Store Connect first. Quotum links it; it does not create or verify its
price, duration, availability or eligibility at Apple. The promotion must be an active discount
allowing `ios`, and the Apple Product ID must identify an active subscription bound to a plan in
the published catalog and covered by the promotion's targets. The active Apple connection binds
the mapping to its bundle ID.

Create a promotion with optional `appleOffers`, or link one afterward:

```http
POST /v1/admin/promotions/spring/apple-offers
Content-Type: application/json

{"objectKind":"apple_promotional_offer","productExternalId":"premium_monthly","offerIdentifier":"spring20"}
```

Use `objectKind: "apple_offer_code"` for native Apple offer codes. `offerIdentifier` is the offer's
identifier from App Store Connect, never a customer's literal redemption code. These routes use
the usual operator identity. `POST .../apple-offers/:offerId/retire` preserves the mapping for
attribution and stops new signatures. It does not disable the offer at Apple. Retired identifiers
cannot be relinked to another promotion.

For a signed promotional offer, validate a Quotum code with `channel: "ios"` to discover the
ready `appleOffers`, then redeem against an already linked subscription:

```http
POST /v1/billing-accounts/customer_123/promotion-redemptions
Idempotency-Key: apple-spring-1
Content-Type: application/json

{"code":"SPRING20","channel":"ios","appleOfferId":"<mapping UUID>","subscriptionId":"<Quotum subscription UUID>"}
```

The response's `data.kind` is `provider_action_required`, `provider` is `apple`, and `appleOffer`
contains `productId`, `offerIdentifier`, `appAccountToken`, `keyId`, `nonce`, `timestamp`, `signature`
and `expiresAt`. `timestamp` is milliseconds since the Unix epoch; the ECDSA signature expires
24 hours later. Pass those values to StoreKit's promotional-offer purchase option and pass the
same `appAccountToken` to the purchase. The app must submit the completed transaction through
`POST /v1/purchases/verify`; a signed response only reserves a code use and never grants access.
The purchased catalog plan supplies entitlements.

A reservation has one redemption per linked offer and original Apple subscription, including
all discounted renewals. To retry an unused reservation, call
`POST /v1/billing-accounts/:billingAccountId/promotion-redemptions/:redemptionId/apple-signatures`
with a new `Idempotency-Key`. It checks the live mapping, code, account and subscription again,
then issues a fresh nonce and 24-hour signature using the same redemption. The same attempt key
replays its exact signature, even after expiry; it never silently refreshes. A different key is
required for a fresh attempt. Released reservations must pass the limits again. Applied or reversed
redemptions cannot be refreshed. Validation and signature issuance share code-entry rate limiting.

Native Apple offer codes are redeemed through Apple's UI. Quotum does not allocate a local code
or sign them. Verified transactions with `offerType` 2 or 3 and a mapped `offerIdentifier` confirm
a reservation or create a provider-observed redemption. Missing `appAccountToken` is accepted on
explicit native-code verification only when `originalTransactionId` is already owned by the same
billing account; a conflicting token remains an error. There is no purchase-claim endpoint.

Purchase verification, notifications and reconciliation use the same observation path. Late
purchases remain recorded after reservation release, code expiry or mapping retirement, with any
applicable limit violation. Repeated notifications and renewals do not consume another use.
Refund/revocation changes the attributed use to `reversed`; refund reversal restores it. Refunds
do not free code capacity. Ledger entries expose the mapping, initial and latest transaction IDs;
a native use has `promotionCodeId: null` and `code: null`.

The bundled SDK exposes `promotions.linkAppleOffer`, `retireAppleOffer`, `redeem` and
`refreshAppleSignature`. Install the API/schema revision first, then deploy a UI whose generated
contract is pinned to that revision. Existing web and Android clients retain their response shapes.

`POST /v1/admin/promotion-redemptions/:redemptionId/revoke` takes back a Quotum grant. It needs the
operator key, `X-Billing-Actor`, an `Idempotency-Key`, and a `reason`. Every unexpired reward
allocation stops counting; what was already consumed stays consumed, and the response reports the
reversed, consumed, and held quantity per allocation. The use stays counted against the code's
limits. Only applied `quotum` redemptions can be revoked (`PROMOTION_REDEMPTION_NOT_REVOCABLE`);
refund Stripe purchases instead. A second revocation with another key returns
`PROMOTION_REDEMPTION_ALREADY_REVERSED`.
