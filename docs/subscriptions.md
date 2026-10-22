# Subscriptions and commercial actions

- Document kind: Current behavior

```http
POST /v1/billing-accounts/:billingAccountId/commercial-actions/preview
POST /v1/billing-accounts/:billingAccountId/commercial-actions
```

Commercial preview accepts an optional `provider` (`stripe` by default, or `paddle`) and one complete intent. Stripe accepts (`checkout_plan`, `checkout_product`,
`subscription_change`, `cancel`, `uncancel`, or `setup_payment`) and returns exact or
provider-calculated amounts
valid for 15 minutes. Execution accepts only the `previewToken` with an `Idempotency-Key` and
rejects expired previews, catalog or customer drift, or a changed target. A durable
subscription-change result is HTTP 202; every other result, including a cancellation, is HTTP 200.

## Embedded Checkout

`checkout_plan` and `checkout_product` take an optional `uiMode`, `hosted` by default. With
`uiMode: "embedded"` the execution creates a Stripe Embedded Checkout session (see the
[Checkout flow](providers.md#stripe)) and answers its client secret instead of a URL, alongside a
promotion code's discount and redemption like any checkout:

```json
{"success":true,"data":{"kind":"checkout","sessionId":"cs_<id>","clientSecret":"cs_<id>_secret_<value>","duplicate":false,"promotionRedemption":{"id":"<uuid>","status":"reserved"}}}
```

The intent hash includes `uiMode` only when it is `embedded`, so hosted previews keep theirs. An
embedded intent takes no `cancelUrl`. The stored execution keeps the session id but never the client
secret: executing the same token with the same `Idempotency-Key` again reads the session from Stripe
and answers its current secret. A new preview is a new token and creates a new session; to show an
earlier one again, read `GET .../providers/stripe/checkout-sessions/:sessionId`, which answers
`{sessionId,status,paymentStatus,customerEmail,productKey,clientSecret}`. Its `clientSecret` is
Stripe's current secret only while the session is `open` and embedded, and `null` for a hosted,
complete or expired session; `POST .../expire` answers the same shape with `clientSecret: null`.
Only a full project credential reaches these `/v1` routes: no read-only credential, MCP tool,
merchant console operation or change proposal can read a client secret. The merchant console and MCP change proposals store what they answer,
so they refuse an embedded intent with `400 INVALID_REQUEST`, at preview and at execution alike.
Paddle answers `400 PADDLE_OPERATION_UNSUPPORTED`.

## Licensed quantities

Licensed `quantities` (seats and the like) arrive on `checkout_plan`, `subscription_change` and
`setup_payment` intents, on `POST .../providers/stripe/checkout-sessions` and on
`POST .../subscriptions/:subscriptionId/changes`. A quantity stays within a price's
`minimumQuantity` and `maximumQuantity`, and never above 2,147,483,647, the range of a
subscription item's stored quantity, even when the price sets no `maximumQuantity`. A larger
quantity answers `400 INVALID_QUANTITY` before anything is reserved, previewed or sent to Stripe.
Execution checks the stored intent again, so a preview that predates the bound is refused rather
than sent.

A preview states a flat total exactly or not at all. Where a flat line's unit amount times its
quantity, or the sum of the lines, passes 9,007,199,254,740,991 minor units (the largest integer a
JSON number holds exactly), the preview answers `400 INVALID_QUANTITY` instead of a rounded amount.
Tiered lines are priced by Stripe and are not limited this way. The bound covers what Quotum
creates; a quantity set in Stripe directly, such as in the Dashboard, is not checked by it.

## Paddle fixed-plan checkout

Paddle is sandbox-only and accepts `checkout_plan` and `checkout_product` through the same routes.
For a fixed plan, publish an account-visible base plan with one flat base price component bound to
an active Paddle subscription mapping. Both remote price quantity bounds must be one. Trials,
additional paid items, paid overage, entity-scoped allocations, promotions, explicit expiry and
custom success/cancel URLs are refused. A new Paddle customer needs an email. An account already
holding an active base plan cannot start another common checkout.

```json
{"provider":"paddle","intent":{"kind":"checkout_plan","planKey":"pro-monthly","quantities":{},"email":"buyer@example.com"}}
```

The preview returns `provider: "paddle"`, `action: "checkout_plan"`, one quantity-one line and
`toPlanVersionId`. Its subtotal is the catalog amount; `amountStatus: "provider_calculated"`,
`estimatedTotalMinor: null` and a null line total leave final tax to Paddle. The private connection,
price binding and plan snapshot are never returned. Execution sends only the token, with the same
`Idempotency-Key` on every retry:

```json
{"previewToken":"11111111-1111-4111-8111-111111111111"}
```

A successful execution returns HTTP 200:

```json
{"success":true,"data":{"kind":"checkout","sessionId":"txn_<id>","url":"https://merchant.example/pay?_ptxn=txn_<id>","duplicate":false}}
```

The stored preview selects the provider. Before execution starts, catalog, customer or connection
drift makes the token stale, and the 15-minute expiry applies. Once claimed, an interrupted Paddle
execution can resume with the same token/key after that expiry, using its recorded connection
version and immutable target. `409 PROVIDER_OPERATION_PENDING` exposes an operation ID for the
[receipt and recovery flow](operations.md#provider-write-recovery-foundation); it does not invite a replacement key or checkout.
Completed results replay without a provider call and remain immutable across concurrent completions.

Common and direct Paddle checkout share one durable reservation per project/billing account.
Two previews may coexist, but only one can execute. A competing execution returns
`409 PADDLE_CHECKOUT_PENDING`, with the owning `previewToken` and/or `operationId` when available;
the losing preview remains unclaimed. Resume the original checkout using its token/key. A successful
transaction-create receipt does not release the reservation: the transaction may still be payable.
The reservation closes after definitive provider rejection, authenticated transaction
cancellation, committed fulfillment, or a local failure before any operation was bound for dispatch.
Preview expiry, browser closure and credential rotation do not release it. Once access is active,
`BASE_PLAN_ALREADY_ACTIVE` prevents another purchase.

Malformed email returns `400 INVALID_REQUEST`; missing email for a new customer returns
`400 PADDLE_CUSTOMER_EMAIL_REQUIRED`. Invalid stored Paddle context returns
`409 COMMERCIAL_PREVIEW_STALE` before execution is claimed. Completed receipts remain replayable
without reading that context. Preview and execution check the retained customer creation intent
before any checkout reservation: a different email returns `409 IDEMPOTENCY_CONFLICT`; the same
failed intent returns `409 PROVIDER_OPERATION_FAILED`. That receipt stays terminal for its own key;
a new checkout key creates the customer once after a definitive rejection (see
[provider write recovery](operations.md#provider-write-recovery-foundation)). Merchant same-key
replay returns the stored HTTP 200 result, including production step-up receipt replay; a different
key cannot reuse that authorization.

Verified server events grant the purchased plan version and its price component, even if a newer
catalog version was published while payment was open. The browser callback and checkout receipt
do not grant access. Merchant billing API dispatch uses the same routing and validation; merchant
UI provider selection is a separate increment. The SDK accepts
`client.commercial.preview(accountId, intent, "paddle")`; execution is unchanged.

The direct route `POST /v1/billing-accounts/:billingAccountId/providers/paddle/checkout-sessions`
validates its `Idempotency-Key` like Stripe's: 1 to 200 letters, digits and `._:-`, otherwise
`400 INVALID_IDEMPOTENCY_KEY` before anything is reserved or sent. A product key that is unknown,
inactive or has no active web mapping answers `404 BILLING_PRODUCT_NOT_FOUND` on both routes;
`PADDLE_FULFILLMENT_MISMATCH` stays for server events that disagree with the recorded checkout. A
completed receipt replays against the price it recorded, so a replacement mapping the product gained
since cannot turn the replay into a conflict.

## Allowances across a plan change

When a subscription moves to another plan version, the quantity the outgoing version granted ends
with it and the incoming version grants afresh. That applies to an API change, a catalog migration
and a switch in the provider's portal. The switch happens when Quotum records the provider's
update:

- The outgoing version's live plan allowances end at that moment and are not rolled over.
- The incoming version's allowance for the current period, or reset window, is granted in full.
- A version grants that allowance at most once per period or window, and a lifetime allowance
  (no reset, no expiry) once per subscription. A subscription that returns to a version it held
  earlier in the same period or window, or at any time for a lifetime allowance, gets that
  allowance back as it was left, with its use kept, not a fresh one. A carry taken from it ends, and its quantity returns
  to the resumed allowance instead of counting twice; what the carry spent is taken from it.
- Allowances that already ended at a period boundary roll over under the old item's policy as
  before, so a period-end change keeps its rollover.
- Top-ups, promotion rewards, operator grants, plan grants and rolled-over quantity are not
  plan-granted and are untouched.
- An open reservation still settles from its hold on the ended allowance.
- A non-consumable meter's usage is a level, such as projects in use, so it is not ended but kept.
  When the incoming version allocates the feature in the same scope, the allowance holding the
  level moves to the incoming version's item, with the incoming item's period and expiry, and its
  quantity becomes the larger of the new allowance and the level. A level above the new allowance
  therefore stays, and nothing can be added to it; as corrections or released holds lower the
  level, the allowance shrinks with it until the new allowance caps it again. Several allowances
  that hold one level, such as allowances stacked by renewals before lifetime grants, shrink as one:
  no room appears while their total level is at or above the new allowance. No carry-over is
  involved, and none can be requested for a non-consumable. A feature the incoming version does
  not allocate ends with the outgoing version, and an item granted per reset window inside the
  billing period keeps its own windows. The default plan keeps a level by the same move: its
  allowances stay for the rest of their window when the feature is still allocated.

An immediate `subscription_change` intent can carry some of that over, per consumable feature:

```json
{ "intent": { "kind": "subscription_change", "externalSubscriptionId": "sub_123",
  "targetPlanKey": "pro", "effectiveMode": "immediate",
  "carryOver": { "balances": ["ai_credits"], "usages": ["ai_credits"] } } }
```

- **`balances`:** the unused quantity of each live outgoing allowance of the feature becomes a
  one-off `carry_over` allocation. It expires at the end of the new plan's first reset window for
  that feature, or at the end of the billing period when the new item does not reset or the new
  plan lacks the feature. What a lifetime allowance left never expires: it stays the lifetime
  credit the outgoing version granted. It is never rolled over, and the balance breakdown names its
  origin in `carryOverOriginAllocationId`. A usage correction of what the outgoing allowance spent
  before the switch grows the carry by the quantity returned, as if the correction had come first,
  and a return to the outgoing version hands that quantity back to the resumed allowance. A switch
  that carried nothing, because the allowance had nothing unused, leaves no carry to take it.
- **`usages`:** the feature's usage in the outgoing allowance's current reset window, its period
  when it does not reset, or everything a lifetime allowance consumed, is written as consumed
  quantity on the new allowance, so an upgrade does not reset consumption. Usage in earlier windows of the period has reset already and
  does not carry. It is capped at what the new allowance holds; usage beyond it is forgiven, not
  charged. Usage is counted once: when a return resumes an allowance that already holds some of
  the outgoing allowance's usage, because that usage was carried from it, or onto it on an earlier
  switch, only the rest is carried. This includes usage shared through a third plan: switching
  A → B → C → A → B with `usages` each time and consuming 20 before each switch leaves B with
  80 consumed and 20 available when every plan grants 100 in the same window. Switching
  A → B → A → C → B and consuming 1 before each switch leaves B with 4 consumed. Each carry
  preserves the portions of usage already shared by the allowances, up to the quantity actually
  applied by earlier carries. A carry of nothing is not recorded in `carried_usages`. Correcting
  usage that was carried takes it back from the new allowance too, and reduces
  `applied_quantity` by what the correction returned, so `requested_quantity` minus
  `applied_quantity` is no longer only what the cap forgave.
- The preview reports `carryOver.features[]`, with each feature's current unused balance and the
  usage the switch would carry, and whether it carries. Those figures are indicative: the switch carries what the allowances hold
  when Quotum records the provider's update. When the provider reports the new version before the
  worker has recorded the change as applied, that update performs the switch and the carry-over,
  once; recording the change later carries nothing again.
- The choice enters the intent hash. These return `400 INVALID_REQUEST`, because the change would
  carry nothing: a feature that is not a consumable meter, one the current plan does not allocate,
  `usages` naming a feature the new plan does not allocate, since there is no allowance to write
  the usage onto, and a change that keeps the plan version, such as one of quantities alone, since
  no allowance ends. A change that takes effect at period end, whether requested or resolved,
  returns `400 CARRY_OVER_REQUIRES_IMMEDIATE_CHANGE`, because the reset does that work.
- Only the previewed commercial action carries over. `POST .../subscriptions/:subscriptionId/changes`
  refuses the field.

## Which plan version a Stripe update applies

Stripe's view of a subscription decides its plan version. When Quotum records a Stripe update:

- The subscription holds the version its Stripe price belongs to. A switch in the customer portal to
  another plan's price, or to another published version of the same plan that has its own price,
  moves the subscription to that version with the allowance handling above and no carry-over. A
  newer version that reuses the same price leaves existing subscriptions on their pinned version.
  So does another plan that takes over the price, for example after its own plan was retired:
  publishing moves nobody, on Stripe or in an app store, and only new purchases of the product
  get the plan it is now bound to.
  The switch is read from the subscription's first Stripe item, the item whose product the plan
  binding names: the base price's, or the seat price's for a plan
  [priced only by its seats](catalog.md#canonical-intent). A subscription whose first item is an
  add-on price, or a seat price of a plan that has a base price, stays on its pinned version and
  records the prices it cannot place as unbound, below, instead of moving.
- An applied API change or catalog migration takes effect when Stripe reports its target. Quotum's
  own update stamps the change's id in the subscription's metadata (`billingChangeId`), and Stripe
  keeps it on every later copy. An update that carries the stamp and shows anything else, for
  example because the customer switched in the portal after the change, is Stripe's final word: the
  change is settled without effect and its carry-over is dropped. An update without the stamp was
  taken before the change reached Stripe, such as a late event or a reconciliation read that raced
  the change, and leaves the change waiting for its own update. Only an update with no metadata at
  all falls back to comparing Stripe's timestamp with when the change was applied. Invoices carry
  the metadata Stripe froze when it finalized them.
- A queued change staged from a version the subscription no longer holds is cancelled with
  `The subscription moved to another plan version at the provider`, releasing its promotion use and
  failing its catalog migration job, as a cancellation does. A change the worker already holds ends
  the same way before the worker calls Stripe.
- Updates apply in Stripe's event order, so an older event that arrives late never moves the
  subscription back. A reconciliation read of the live subscription counts as an update from the
  moment the read began, less one minute: an event Stripe created before then is already in the read
  and changes nothing when it arrives later, while an event created after it still applies. The
  minute keeps a newer event from being dropped when the host's clock runs ahead of Stripe's; an
  older event from that last minute before the read can still apply until the next update.
- Events Stripe created in the same second have no order of their own, so the state that cannot be
  undone wins. A cancellation or expiry applies over the live state it ties with, even when it ends
  ahead of the period that was paid through, as an immediate cancellation does, and a live update of
  the same second never revives it. A copy of an earlier period, one that starts before the
  recorded period, is stale whatever its status. Between live states the later period end wins.
- A subscription Stripe ended expires when Stripe ended it, not at the period it was paid through.
  A reconciliation read applies that ending as the webhook does, so a lost or dropped
  `customer.subscription.deleted` for an immediate cancellation is repaired; a read that began
  before an ending Quotum already recorded never moves the subscription back to a live state.
- A Stripe price that no published version binds does not fail the update. The subscription's status,
  period and cancellation are recorded, it keeps its plan version and the items it already tracks,
  and the store event's `processingError` names the unbound prices, for example
  `Stripe prices price_x have no published binding on the subscription's plan version; it keeps plan
  pro version 2`. Bind the price in the catalog and the next update applies it.

## Cancelling and uncancelling a subscription

`cancel` names `externalSubscriptionId` and an `effectiveMode`; `uncancel` names the subscription
alone:

```json
{ "intent": { "kind": "cancel", "externalSubscriptionId": "sub_123", "effectiveMode": "immediate" } }
{ "intent": { "kind": "cancel", "externalSubscriptionId": "sub_123", "effectiveMode": "period_end" } }
{ "intent": { "kind": "uncancel", "externalSubscriptionId": "sub_123" } }
```

The preview carries no line items and a zero total, because a cancellation moves no money, and adds
a `cancellation` object: the `action` it would perform (`cancel`, `uncancel`, or `none`), when
access ends (`accessEndsAt`), the `cancelAtPeriodEnd` state it would leave, whether granted
allocations are kept, when open postpaid usage settles, the queued change it would supersede, and
the account's active add-on subscriptions. Asking for a state that already holds previews as
`none`: a `period_end` cancel on a subscription that already ends at its period end, or an
`uncancel` with nothing pending. Executing such a preview calls no provider and returns
`action: "none"`.

Execution returns
`{ "kind": "subscription_cancellation", "action", "externalSubscriptionId", "effectiveMode",
"effectiveAt", "cancelAtPeriodEnd", "supersededChangeId" }`.

What a cancellation does, on Stripe and through the customer portal alike:

- An **immediate** cancel ends the subscription and its access entitlements — boolean features,
  seats and postpaid overage — at once, and asks the provider for no proration credit.
- Plan **allocations already granted** for the paid period stay spendable until their own expiry.
  [Refunding the subscription's payment](providers.md#refunds-of-subscription-payments) takes back
  the refunded share of the credits that payment funded, never below what was already spent.
- **Postpaid usage is not accelerated.** Overage accrued in the open period settles when that usage
  window ends, on the schedule it already had; the invoice is then billed to the customer against
  their saved default payment method, because the subscription is gone.
- A cancel **supersedes** the subscription's queued change: it is marked `cancelled` and its
  promotion use released. `uncancel` does not restore it — request the change again.
- A **base plan with active add-on subscriptions is refused** with `ADDON_SUBSCRIPTIONS_ACTIVE`
  (409), whose `details.addOnSubscriptionIds` names them; cancel the add-ons first. Cancelling an
  add-on itself is never held back.

Typed refusals: `SUBSCRIPTION_NOT_CANCELLABLE` (409) when the subscription has already ended, so
there is nothing left to cancel or to uncancel; `ADDON_SUBSCRIPTIONS_ACTIVE` (409);
`SUBSCRIPTION_CHANGE_PENDING` (409) while a worker is applying that subscription's change, which is
retryable; and `SUBSCRIPTION_PERIOD_MISSING` (409) for `period_end` without a known period end.

Local subscription state still arrives only through the provider webhook, or through reconciliation
when a webhook is lost, so `cancelAtPeriodEnd` and the subscription's status change when Stripe
reports them, not when execution returns.

Limitation: a Stripe subscription schedule attached outside Quotum is invisible here. Quotum
cancels the subscription; it does not release or amend a schedule that may recreate it.

## Refunding a payment

`refund` asks the payment provider to return money for one payment and records who asked, how much
and why. It goes through the same preview and execute pair as every commercial action, so a
read-only credential is refused and the amount a caller approves is the amount that is sent. Only a
trusted backend with a full project credential asks for a refund: the console and MCP change
proposals refuse the intent with `400 INVALID_REQUEST`, because the summary a person reviews there
describes what a preview charges and has no words for money going back.
Stripe is the only provider that issues refunds through Quotum. Apple decides refunds of its own
purchases and exposes no API to issue one, so a refund aimed at an Apple purchase is
`409 REFUND_PROVIDER_MANAGED`; Google Play and Paddle refunds are made in their own consoles, and
Quotum mirrors them through [refund sync](providers.md#refunds-of-subscription-payments).

```json
{ "intent": { "kind": "refund",
              "target": { "type": "subscription_payment", "externalSubscriptionId": "sub_123" },
              "mode": "prorated", "cancelImmediately": true, "reason": "Customer asked to leave" } }
{ "intent": { "kind": "refund",
              "target": { "type": "purchase", "purchaseId": "7b0c2f4e-5b1e-4f0a-9f0e-1d2c3b4a5e6f" },
              "mode": "full", "reason": "Duplicate purchase" } }
```

- A **subscription payment** is the subscription's latest paid invoice. A **purchase** is a
  completed one-time purchase, such as a credit pack, named by the `purchaseId` the purchase reads
  return.
- `full` returns everything the payment paid, net of earlier refunds. `prorated` returns the unused
  share: for a subscription payment the share of the paid period still ahead, measured from the
  moment of the preview to the end of the period the invoice's advance-billed lines cover; for a
  top-up the share of the credit pack not yet spent. Amounts are whole minor units, rounded down,
  and never more than what is still refundable.
- `cancelImmediately` ends the subscription once the provider has accepted the refund, exactly as an
  immediate [cancellation](#cancelling-and-uncancelling-a-subscription) does, and applies to a
  subscription payment only. A refund that fails leaves the subscription running.
- `reason` is required, up to 500 characters, and is stored with the request.

The preview answers `refund`: the payment (`providerPaymentId`, `externalInvoiceId` or
`purchaseId`), `amountPaidMinor`, `refundedMinor`, `refundableMinor`, the `refundAmountMinor` this
request would return, its `basis` (`full`, `remaining_time` or `unconsumed_credit`) and the
subscription it would also cancel. The preview is stale (`COMMERCIAL_PREVIEW_STALE`) as soon as
anyone refunds the payment, including in the Stripe Dashboard.

Execution records the request, then asks Stripe under a key derived from the execution, and answers
`{ "kind": "refund_request", "refundRequestId", "status", "amountMinor", "currency",
"providerRefundId", "cancellation" }`. `status` is `succeeded` when Stripe paid it out and `pending`
when it accepted the refund but has not; a `pending` refund settles later, and
`GET /v1/billing-accounts/:billingAccountId/refunds` (a read a read-only credential may make) lists
the requests newest first with their current `status` (`succeeded`, `failed` or still `pending`)
and, for a failure, its `failureCode`.

**The credits follow the money, not the request.** Nothing in the ledger changes when execution
returns. When Stripe's refund event arrives, the refund reverses the credits the payment funded
through the same path as a refund made in the Dashboard: a one-time purchase in proportion to the
amount returned, and a subscription payment's period allocations in proportion to the amount
returned, never below what is already spent or held. A refund that fails or is canceled reverses
nothing.

One refund may be open per payment (`REFUND_ALREADY_OPEN`, 409, with the request in `details`), and
a refund never exceeds what was paid net of earlier refunds (`REFUND_NOTHING_REFUNDABLE`, 409).
Repeating an execution with the same `Idempotency-Key` answers the same result and never refunds
twice, even when the first attempt's answer was lost; another key is `IDEMPOTENCY_CONFLICT`. A
request that Stripe's own idempotency window could no longer vouch for is looked up in Stripe
instead of sent again, and one whose outcome still cannot be established is held as
`REFUND_RECONCILIATION_REQUIRED` (409) for an operator to check in Stripe, keeping the payment's
slot until then.

Typed refusals: `PAYMENT_NOT_REFUNDABLE` (409) for an invoice or purchase Stripe did not collect
with a refundable payment, a purchase that is not completed, or a one-time purchase that is a
subscription's own payment; `REFUND_NOT_PRORATABLE` (409) when the invoice names no service period
or the purchase funded no credit, where `full` still works; `REFUND_REJECTED_BY_PROVIDER` (409)
when Stripe refused the refund, with Stripe's error code in `details.providerCode`.

The Stripe key needs write access to Refunds ("Charges and Refunds: Write" in the Dashboard's
restricted-key editor). A connection validated before this feature may lack it; refunding then
fails with `REFUND_REJECTED_BY_PROVIDER` and `details.providerCode` `permission_error`, and the
connection's validation lists `refund_write` among its unverified permissions.

## Saving a payment method

`setup_payment` sends the customer to a provider-hosted page where they save a payment method for
later off-session charges. Cards are supported first, authentication included. An optional `plan`
starts that plan on the saved card once setup completes. There is no promotion code on this path;
a discount still goes through `checkout_plan`.

```json
{ "intent": { "kind": "setup_payment", "currency": "usd" } }
{ "intent": { "kind": "setup_payment", "currency": "usd", "email": "payer@example.com",
              "successUrl": "https://app.example.com/billing",
              "cancelUrl": "https://app.example.com/billing" } }
{ "intent": { "kind": "setup_payment", "currency": "usd",
              "plan": { "planKey": "pro", "quantities": { "seats": 5 } } } }
```

`currency` is required. Without a plan it only selects which setup methods the hosted page offers
and does not bind the account to that currency. With a plan it must equal the plan's currency
(compared case-insensitively); a mismatch is `400 INVALID_REQUEST` with `details.currency` and
`details.planCurrency`. `successUrl` and `cancelUrl` default to the connection's configured
customer-application URLs and are checked against its approved return origins, exactly as Checkout
and portal returns are (`RETURN_URL_NOT_ALLOWED`, 400). Setup previews reject email addresses longer than 320 characters
and return URLs longer than 2,000 characters before storing any state.

Without a plan the preview carries no line items and a zero total. With a plan it carries that
plan's lines and totals, `toPlanVersionId`, and `paymentSetup.plan`
(`planKey`, `planVersionId`, `trialDays`, `startsAfterSetup: true`). `trialDays` is the trial that
will start, or null when the plan has none or this account already used it. Either way the preview adds a
`paymentSetup` object: the `currency`, `appliesTo: "account_default"`,
`preservesSubscriptionPaymentMethods: true`, and whether executing would reuse an unfinished setup
(`reusesExistingSetup`, `existingSetupId`, `existingSetupExpiresAt`). A setup with a plan goes stale
when the plan version, the account's active base plan, or whether that account already used the
plan's trial changes before execution
(`COMMERCIAL_PREVIEW_STALE`, 409). An account that already had the trial starts the subscription
without one, the same way Checkout does. A setup without a plan has no catalog state to drift. Previews
still expire after 15 minutes.

Execution rechecks the previewed plan version before reserving the setup. A catalog publication
that races with the execution claim also returns `COMMERCIAL_PREVIEW_STALE`, without creating a
setup link for the replacement version.

An add-on without an active base plan is `ADDON_REQUIRES_BASE_PLAN` (409), and one whose meter
limits cannot add up with the account's is `ADDON_METER_LIMIT_CONFLICT` (409). A plan, base or
add-on, whose meter limits declare another `allocationScope` than limits the account's other
subscriptions hold on the same feature is `ADDON_METER_LIMIT_CONFLICT` (409) with
`details.reason: "scope"`; so is a plan change or catalog migration to such a version (see
[declared meter-limit scope](metering.md#meter-limits)). A base plan when the
account already has an active one is `BASE_PLAN_ALREADY_ACTIVE` (409): change it with
`subscription_change`. Checkout can still sell that base plan from a hosted page; this charge cannot.

Execution returns `{ "kind": "payment_setup", "setupId", "status", "sessionId", "url", "expiresAt", "reused", "plan" }`
with HTTP 200. `plan` is null, or `{ planKey, planVersionId, status }` with `status: "pending"`
until the customer finishes. The link lives for 23 hours, leaving margin within Stripe's expiry window. **Creating the link does not mean setup completed** —
read the setup session to learn that.

One unresolved setup exists per billing account and provider identity:

- A matching request (same currency, email, return URLs and plan version) gets that setup's link back unchanged,
  with `reused: true`. Card-only setups reserved before optional plan support remain reusable after
  a data-preserving upgrade; their request hashes keep the original format.
- A differing request is refused during preview with `PAYMENT_SETUP_ALREADY_ACTIVE` (409), whose
  `details.paymentSetup` names the active `setupId`, its `status` and its `expiresAt`.
- Only a completed setup or a provider-confirmed expiry frees the slot; a new preview is then
  required. Replaying a stored execution key returns its original result. If execution outcome
  persistence was interrupted, recovery returns the original setup's current status without
  creating another provider session. `sessionId` can be null when creation remains uncertain;
  `url` is null unless the setup is `awaiting_customer` and its frozen expiry is still in the future.

```
GET /v1/billing-accounts/:billingAccountId/payment-setup-sessions/:sessionId
```

`:sessionId` accepts either the `setupId` Quotum issued or the provider session id. The response is
persisted state only — no provider call — and reports `status`, `currency`, `expiresAt`,
`completedAt`, `plan` and, once the default-method update is confirmed, a safe `card` summary
(`brand`, `last4`, `expMonth`, `expYear`). `plan` is null, or the attached plan's key, version,
quantities, `status` (`pending`, `started`, `payment_failed`, `plan_changed`, `not_eligible`),
`externalSubscriptionId`, `failure` (`code` and `message`) and `resolvedAt`. The reusable `url` is returned only while the setup is
`awaiting_customer` and unexpired. Because that link is actionable, this read requires a full project credential
(`READ_ONLY_CREDENTIAL`, 403, for a read-only key) and `operations.write` on the merchant surface.

Statuses: `creating` (the link is being made), `awaiting_customer` (the link is open),
`applying_default` (the customer finished and the default-method update is owed), `completed`,
`expired`, and `needs_attention` (work that retries could not finish; the setup stays visible and
keeps the account's slot until it is reconciled). A customer cancelling in their browser leaves an
otherwise valid link reusable.

On completion Quotum validates the provider's own record of the setup and then updates only
`customer.invoice_settings.default_payment_method`. Payment methods pinned to individual
subscriptions are untouched. Without a plan, setup starts no charge and retries no old invoice: a
suspended automatic top-up policy still needs its own explicit reset.

With a plan, the row stays `applying_default` until the plan outcome is terminal, then the setup
completes and releases the slot. Quotum creates the subscription on the customer default card with
`payment_behavior: error_if_incomplete` and `off_session`. A decline or a card that needs
authentication (`402`) does not create a subscription: the card stays saved, `plan.status` is
`payment_failed`, and `plan.failure.code` is Stripe's code. Start the plan afterwards with
`checkout_plan`. A plan version that changed after the preview was issued leaves `plan_changed`
and does not start. An add-on that lost its base plan or whose meter limits no longer add up with
the account's, or a base plan the account gained in the meantime, leaves `not_eligible` with that
check's code. `started` means the subscription was
recorded and a projection was queued; a later webhook for the same subscription is idempotent.
On retry, Quotum first recovers any subscription already created for this setup, even if the catalog
or eligibility has since changed. If the subscription id was not persisted, recovery searches all
pages of the customer's subscriptions, including canceled ones. A failed page read retries instead
of treating a partial list as proof that no subscription exists. Failures recording that subscription
or its outcome remain retryable; they do not turn an existing purchase into `not_eligible` or `plan_changed`.
Merchants learn the outcome from the setup session and from that projection. The setup has no
event of its own, but the subscription it starts is recorded like any other, so an
[outbound webhook](webhooks.md) endpoint that subscribes to `subscription.activated` receives it.
