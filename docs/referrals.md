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
  "trigger": "redemption",
  "recipient": "both",
  "maxRewardsPerReferrer": 10
}
```

| Field | Meaning |
| --- | --- |
| `rewardPromotionKey` | The promotion each recipient receives. |
| `trigger` | When a referral earns its rewards. `redemption` means as soon as the code is entered. |
| `recipient` | `referrer`, or `both` for the referrer and the new customer. |
| `maxRewardsPerReferrer` | How many times one referrer can be rewarded. Omit it for no limit. |

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

The SDK call is `client.referrals.redeem(billingAccountId, { code, channel })`. Sending the same code
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
| `discount` | Nothing to apply yet, so the code waits. Pass it as `promotionCode` to the recipient's next checkout or `subscription_change`. | `held` |

A held reward carries its `code`, and only that account can use it. Once it is used the reward reads
`used`. Apple and Google have no server-side discount, so choose credits for customers who pay
through a store.

Rewards are issued right after the redemption. If that fails, the reward reads `pending` and the
promotion maintenance worker retries it with backoff; after eight attempts it reads `failed`, with
the error in `reason`.

`maxRewardsPerReferrer` counts rewards, not uses. Past the limit the referral is still recorded and
the new customer still receives their reward, while the referrer's reads `skipped` with
`REFERRER_LIMIT_REACHED`. A reward whose promotion was archived reads `failed` with
`PROMOTION_ARCHIVED`, and a recipient erased in the meantime reads `skipped` with `RECIPIENT_ERASED`.

Take a reward back with
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

To tell a customer they earned something, subscribe to the
[`referral.reward_issued` event](webhooks.md#event-types). Its data names the reward and never the
other account, and it never carries a code: read a held code from this route.

## Erasure

Erasing an account deletes its referral codes, so they stop working. Referrals and rewards stay,
because they hold only internal ids; an erased side reads `null`, and a reward still owed to it is
skipped. The other side keeps what it was given.
