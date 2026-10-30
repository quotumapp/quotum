# Affiliate tracking

- Document kind: Current behavior

Quotum records which affiliate brought a billing account and reports what that account paid. An
affiliate is a key your backend chooses; Quotum keeps no partner records and needs nothing set up
first. Quotum does not calculate commission or pay anyone: you read the totals and settle with
affiliates yourself.

## Record a key

Send an optional `affiliateKey` with a purchase call. It takes 1 to 200 letters, digits, dots,
underscores and hyphens.

| Purchase | Where the key goes |
| --- | --- |
| Stripe checkout | The body of `POST /v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions` |
| Paddle checkout | The body of `POST /v1/billing-accounts/:billingAccountId/providers/paddle/checkout-sessions` |
| App Store or Google Play | The body of `POST /v1/purchases/verify` |
| Commercial action | The body of `POST /v1/billing-accounts/:billingAccountId/commercial-actions`, next to `previewToken` |

A commercial action records the key only when it answers a checkout, or a payment setup that names
a plan. Other actions accept the field and ignore it, and the console cannot send it.

```json
{ "productKey": "credits_100", "affiliateKey": "acme-partner" }
```

The key belongs to the account, not to one purchase, and the first key stays. A later call with a
different key changes nothing and does not fail. Quotum writes the key after the provider call
succeeds, so a checkout that fails leaves the account unattributed, but one that is started and
abandoned does not: the key stays for the account's later purchases.

Every payment the account makes counts toward its affiliate, including payments from before the
key was recorded. There are no dates, credit periods or expiry.

## Read the totals

Both reads take project authentication and accept a read-only credential. A key nobody has used
answers an empty summary, not `404`.

```http
GET /v1/affiliates/:affiliateKey/summary
GET /v1/affiliates/:affiliateKey/customers?limit=25&cursor=:cursor
```

```json
{
	"success": true,
	"data": {
		"affiliateKey": "acme-partner",
		"customers": 12,
		"revenue": [
			{ "provider": "apple", "currency": "usd", "payments": 8, "amountMinor": 7992, "estimated": true },
			{ "provider": "google", "currency": null, "payments": 3, "amountMinor": null, "estimated": true },
			{ "provider": "stripe", "currency": "usd", "payments": 20, "amountMinor": 200000, "estimated": false }
		]
	}
}
```

Currencies stay on separate rows and are never converted. The customer list answers each account's
`billingAccountId` and `affiliateKeySetAt`, newest account first, and `limit` is at most 100. An
account's purchases are on the existing account and admin reads. The backend SDK offers
`client.affiliates.summary(key)` and `client.affiliates.customers(key, { limit, cursor })`.

An erased account keeps its key, which names the partner and not the person, so the totals stay
correct. It leaves the customer list, and a purchase call cannot set a key on it.

## How amounts are worked out

| Payments | Counted from | Amount | `estimated` |
| --- | --- | --- | --- |
| Stripe subscriptions and automatic top-ups | Paid invoices | Amount paid, less refunds | `false` |
| Stripe one-time purchases and Paddle | Completed purchases | Amount paid, less refunds | `false` |
| App Store | Completed purchases, one per renewal | The product's catalog price | `true` |
| Google Play | The completed purchase, plus each `SUBSCRIPTION_RENEWED` or `SUBSCRIPTION_RECOVERED` notification | The product's catalog price | `true` |

Quotum does not store what a store customer actually paid, so a store total is the catalog price
times the number of payments. A free trial is not a payment. A fully refunded payment is left out.

A store product needs a catalog price before it can show an amount. Without one its payments are
counted on a row with a null `currency` and `amountMinor`. Give an existing product a price with
[`quotum catalog bindings adopt`](catalog.md#register-an-app-store-or-google-play-product), using
`currency` and `priceAmountMinor`; the product's other fields must not change.

Treat a store total as an estimate:

- A product has one price and currency, so a buyer in another country may have paid a different
  price.
- Paid introductory offers and discounts count at full price.
- A Google Play consumable bought with a quantity above one counts once.
- A partial App Store refund is not subtracted.
- One refund on a Google Play subscription drops its purchase from the count; a second refund on
  that subscription is not subtracted.
- A Google Play notification that never arrived is not counted.
