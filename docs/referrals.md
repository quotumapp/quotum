# Referral programs

- Document kind: Current behavior

A referral program lets an existing customer bring a new one and be rewarded for it. Each customer
gets a code to share, a new customer enters it, and Quotum records who referred whom and gives the
reward. The reward is an ordinary [promotion](promotions.md): a discount, free credits or a plan
for a term. Quotum does no fraud scoring or device matching, and it does not stop one person from
making two accounts. Those checks stay in your product, before it calls Quotum.

For partners paid outside your product, use [affiliate tracking](affiliates.md) instead.

## Create a program

A program names one existing promotion as its reward. The promotion must be active, allow the `web`
channel and have no linked Apple offer. Operators create programs with
`X-Billing-Operator-Key` and `X-Billing-Actor`:

```http
POST /v1/admin/referral-programs
Content-Type: application/json

{
  "key": "refer-a-friend",
  "name": "Refer a friend",
  "rewardPromotionKey": "referral-credits",
  "trigger": "first_payment",
  "recipient": "both",
  "maxRewardsPerReferrer": 10,
  "targets": [{ "kind": "plan", "key": "pro" }]
}
```

| Field | Meaning |
| --- | --- |
| `rewardPromotionKey` | The promotion each recipient receives. |
| `trigger` | When a referral earns its rewards: `redemption` as soon as the code is entered, or `first_payment` when the new customer [first pays](#when-a-referral-earns-its-rewards). |
| `recipient` | `referrer`, or `both` for the referrer and the new customer. |
| `maxRewardsPerReferrer` | How many times one referrer can be rewarded. Omit it for no limit. |
| `targets` | For `first_payment`, the plans and products that count, each `{ "kind": "plan" \| "product", "key": ... }`. Omit it for any payment. |
| `excludeTrial` | For `first_payment`, set `false` to count a provider trial starting as the payment. It defaults to `true`. |

`targets` and `excludeTrial` with the `redemption` trigger answer `REFERRAL_PROGRAM_INVALID`, and so
does a target the catalog does not have.

It returns `201`, or `200` when the same key is sent with the same terms; different terms answer
`REFERRAL_PROGRAM_KEY_CONFLICT`. A program cannot be edited: archive it and create another.

- `GET /v1/admin/referral-programs` lists programs, with `limit`, `cursor` and `status`.
- `GET /v1/admin/referral-programs/:programKey` reads one.
- `POST /v1/admin/referral-programs/:programKey/archive` stops new codes and redemptions. Existing
  codes still read, and referrals already recorded keep their rewards.
- `GET /v1/admin/referral-programs/:programKey/referrals` lists who referred whom, newest first,
  with both sides' rewards. An erased account reads `null`.

While a program is active, its promotion cannot be archived
(`PROMOTION_HAS_ACTIVE_REFERRAL_PROGRAM`), and a
[feature its credits use cannot be retired](catalog.md).

## Give a customer a code

```http
PUT /v1/billing-accounts/:billingAccountId/referral-codes/:programKey
```

```json
{
  "success": true,
  "data": {
    "programKey": "refer-a-friend",
    "billingAccountId": "customer_123",
    "code": "K7Q2M9XD",
    "createdAt": "2026-11-01T12:00:00.000Z"
  }
}
```

The call creates the code the first time and returns the same one afterwards. A code has eight
characters without `0 1 I L O`, and matching ignores case. The account must already exist. The SDK
call is `client.referrals.code(billingAccountId, programKey)`.

## Redeem a code

Your backend calls this for the new customer, whose account must already exist:

```http
POST /v1/billing-accounts/:billingAccountId/referral-redemptions
Content-Type: application/json

{ "code": "K7Q2M9XD", "channel": "web" }
```

```json
{
  "success": true,
  "data": {
    "duplicate": false,
    "referral": {
      "id": "0192f3a2-0001-7a10-8b20-c30d40e50f60",
      "programKey": "refer-a-friend",
      "role": "referee",
      "counterpartBillingAccountId": "customer_123",
      "status": "qualified",
      "qualifiedAt": "2026-11-02T09:30:00.000Z",
      "createdAt": "2026-11-02T09:30:00.000Z",
      "rewards": [
        {
          "id": "0192f3a2-0002-7a10-8b20-c30d40e50f61",
          "recipient": "referee",
          "status": "issued",
          "reason": null,
          "promotionKey": "referral-credits",
          "effectKind": "feature_grant",
          "code": null,
          "issuedAt": "2026-11-02T09:30:00.000Z"
        }
      ]
    }
  }
}
```

With the `first_payment` trigger the referral reads `pending` until it qualifies. The SDK call is
`client.referrals.redeem(billingAccountId, { code, channel })`. Sending the same code
again answers the same referral with `duplicate: true` and gives nothing twice, so this call takes
no `Idempotency-Key`. It is limited per project and client IP like promotion code entry, on a
counter of its own; see [rate limits](deployment.md#rate-limits).

| Refusal | Status | Meaning |
| --- | --- | --- |
| `REFERRAL_CODE_NOT_FOUND` | 404 | No such code. |
| `BILLING_ACCOUNT_NOT_FOUND` | 404 | The account does not exist. |
| `REFERRAL_SELF` | 409 | The account's own code. |
| `REFERRAL_ALREADY_REDEEMED` | 409 | The account already redeemed another code of this program. |
| `REFERRAL_CYCLE` | 409 | The owner of the code was referred by this account. |
| `REFERRAL_NOT_NEW_CUSTOMER` | 409 | The account has already paid. A free trial, a free checkout or a payment refunded in full does not count as paying. |
| `REFERRAL_PROGRAM_ARCHIVED` | 409 | The program no longer takes redemptions. |
| `PROMOTION_CODE_CHANNEL_NOT_SUPPORTED` | 409 | `channel` is `ios` and the new customer would receive a reward, as with [direct iOS grants](promotions.md). A program with `recipient: "referrer"` works on every channel. |

## When a referral earns its rewards

With `redemption`, the referral qualifies as the code is entered, and the rewards are issued right
after.

With `first_payment`, it qualifies when the new customer has paid for something the program
targets:

| Provider | What counts |
| --- | --- |
| Stripe subscription | A paid invoice with money still standing after refunds. |
| Stripe one-time purchase, Paddle | A completed purchase with money still standing after refunds. |
| App Store | A completed transaction that is not a free trial, which includes the first renewal after one. |
| Google Play | A completed purchase that is not a free trial, or an active subscription whose period has run past the end of its trial. |

A free trial and a $0 invoice do not count, unless `excludeTrial` is `false`. A payment refunded in
full before it was looked at does not count either. The check follows the payment within one pass
of the promotion maintenance worker, and it reads what is recorded, so a repeated or replayed
provider event gives nothing twice. A referral from an archived program still qualifies.

A new customer's **discount** is issued when the code is entered, even under `first_payment`,
because it is only useful before the payment that earns the referrer's reward. Pass it to that
checkout as `promotionCode`. A paid checkout counts when the discount leaves something to pay.

## What each side receives

Quotum mints one single-use promotion code for each recipient, restricted to that account, and
redeems it as any code is redeemed. A reward therefore appears in the
[redemption ledger](promotions.md) with the actor `"system:referral"`, and its limits, snapshots and
revocation are those of promotions.

| Promotion | What happens | Reward status |
| --- | --- | --- |
| `feature_grant` | The recipient's balance gets the credits. | `issued` |
| `plan_grant` | The recipient holds the plan for its term. | `issued` |
| `plan_grant`, recipient has a paid plan, a trial or another grant | The plan cannot start now, so the code waits. The reward's `reason` is `PROMOTION_BASE_PLAN_ACTIVE` or `PROMOTION_PLAN_GRANT_ACTIVE`. Redeem it later through [`promotion-redemptions`](promotions.md). | `held` |
| `discount`, recipient has a live Stripe subscription | The discount goes on the subscription and applies from its next invoice. Stripe makes no proration or invoice for it. | `issued` |
| `discount`, any other recipient | The code waits. Pass it as `promotionCode` to the recipient's next checkout or `subscription_change`. | `held` |

A held reward carries its `code`, and only that account can use it. Once it is used the reward reads
`used`. Apple and Google have no server-side discount, so choose credits for customers who pay
through a store.

The worker keeps looking at a held discount, so a referrer who subscribes later without using the
code receives it on that subscription. While it waits, `reason` says why:

| `reason` | Meaning |
| --- | --- |
| `DISCOUNT_CODE` | The recipient has no live Stripe subscription, or it is set to cancel. |
| `SUBSCRIPTION_HAS_DISCOUNT` | The subscription already has a discount, the merchant's own included. Quotum looks again a day later, so a second `once` reward goes on after the first is used. |
| `SUBSCRIPTION_CHANGE_PENDING` | A plan change is queued, and it rewrites the same discount list. |
| `PROMOTION_CODE_NOT_APPLICABLE` | The promotion's targets do not cover the subscription's plan. |
| `STRIPE_NOT_CONFIGURED` | The environment has no usable Stripe connection. |

After eight failed Stripe attempts the worker stops trying, and the code stays usable. A discount
that went on cannot be taken back through the revoke route; remove it in Stripe.

If issuing a reward fails, it reads `pending` and the promotion maintenance worker retries it with
backoff; after eight attempts it reads `failed`, with
the error in `reason`.

`maxRewardsPerReferrer` counts rewards, not uses. Past the limit the referral is still recorded and
the new customer still receives their reward, while the referrer's reads `skipped` with
`REFERRER_LIMIT_REACHED`. A reward whose promotion was archived reads `failed` with
`PROMOTION_ARCHIVED`, and a recipient erased in the meantime reads `skipped` with `RECIPIENT_ERASED`.

Take back a credit or plan reward with
[`POST /v1/admin/promotion-redemptions/:redemptionId/revoke`](promotions.md). A later refund of the
new customer's payment changes no reward by itself.

## Read an account's referrals

```http
GET /v1/billing-accounts/:billingAccountId/referrals?role=referrer&limit=25
```

`role` is `referrer` or `referee`; leave it out for both. Each referral carries the other account
as `counterpartBillingAccountId`, which is `null` once that account is erased, and only this
account's own rewards, so one side never sees the other's codes. The read needs a full project key,
because a held reward carries its code. The SDK call is
`client.referrals.list(billingAccountId, { role, limit, cursor })`.

The merchant console reads the same list for a customer's page, through
`GET /api/billing/admin/billing-accounts/:billingAccountId/referrals`.

To tell a customer they earned something, subscribe to the
[`referral.reward_issued` event](webhooks.md#event-types). Its data names the reward and never the
other account, and it never carries a code: read a held code from this route.

## Erasure

Erasing an account deletes its referral codes, so they stop working. Referrals and rewards stay,
because they hold only internal ids; an erased side reads `null`, and a reward still owed to it is
skipped. The other side keeps what it was given.
