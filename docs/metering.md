# Metering

- Document kind: Current behavior

Trusted backends authorize work through these routes:

```http
PUT    /v1/billing-accounts/:billingAccountId
GET    /v1/billing-accounts/:billingAccountId
GET    /v1/billing-accounts/:billingAccountId/usage/receipts/:receiptId
GET    /v1/billing-accounts/:billingAccountId/usage/receipts/:receiptId/deductions
GET    /v1/billing-accounts/:billingAccountId/entities/:entityId
GET    /v1/billing-accounts/:billingAccountId/balances/:featureKey
GET    /v1/billing-accounts/:billingAccountId/billing-summary
GET    /v1/billing-accounts/:billingAccountId/usage/events
GET    /v1/billing-accounts/:billingAccountId/usage/series
POST   /v1/billing-accounts/:billingAccountId/usage/check
POST   /v1/billing-accounts/:billingAccountId/usage/consume
POST   /v1/billing-accounts/:billingAccountId/usage/reservations
POST   /v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/confirm
POST   /v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/release
POST   /v1/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections
POST   /v1/billing-accounts/:billingAccountId/entities
GET    /v1/billing-accounts/:billingAccountId/entities
PUT    /v1/billing-accounts/:billingAccountId/controls
GET    /v1/billing-accounts/:billingAccountId/controls
POST   /v1/billing-accounts/:billingAccountId/usage-alerts
GET    /v1/billing-accounts/:billingAccountId/usage-alerts
GET    /v1/billing-accounts/:billingAccountId/usage-alert-events
PUT    /v1/billing-accounts/:billingAccountId/auto-topup
GET    /v1/billing-accounts/:billingAccountId/auto-topup?featureKey=:featureKey[&entityId=:entityId]
GET    /v1/billing-accounts/:billingAccountId/license-pools
POST   /v1/billing-accounts/:billingAccountId/license-assignments
DELETE /v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId
GET    /v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey
POST   /v1/billing-accounts/:billingAccountId/commercial-actions/preview
POST   /v1/billing-accounts/:billingAccountId/commercial-actions
GET    /v1/billing-accounts/:billingAccountId/payment-setup-sessions/:sessionId
GET    /v1/billing-accounts/:billingAccountId/entitlements
```

## Accounts, checks and consumption

Create an account explicitly with `PUT /v1/billing-accounts/:billingAccountId` and an empty body.
It returns `{ id, createdAt }`; repeated creation preserves the record and applies a default plan
only when inserting the account. `GET` retrieves it or returns `BILLING_ACCOUNT_NOT_FOUND`.
Identifiers are exact, case-sensitive strings of 1–200 characters without surrounding whitespace.
Usage mutations and entity creation require an existing account. The `/billing-account` child
resource remains the provider-specific Stripe summary, separate from this account record.

`POST /usage/check` and `POST /usage/consume` use `featureId` and decimal-string `value`:

```json
{"featureId":"model_tokens","value":"150","entityId":"workspace-1"}
```

`entityId` and ISO `occurredAt` are optional. Filters, arbitrary metadata, and the former
`featureKey`/`quantity` names are rejected on these two routes. Boolean checks omit `value` and
`occurredAt`; metered checks and consumption require a positive value. Checks write nothing and
include `checkedAt`. Expected denials are HTTP 200 with `allowed: false` and `reason`; allowed
results omit `reason`. Configuration failures are typed errors, including `USAGE_NOT_CONFIGURED`.
Plain decimal strings normalize redundant leading and trailing zeroes before fingerprinting.
Signs, exponent notation, whitespace and zero usage are rejected; feature scale and storage bounds
still apply. Public responses contain canonical decimal strings.

Metered results contain `featureId`, exact `entityId` (null for account scope), `usage` and `rated`
quantities (`featureId`, `unit`, `value`), and a bounded `balance` with `featureId`, `unit`, `granted`,
`consumed`, `held` and `available`. Boolean checks omit those quantities and balance. Consume also
returns `operation: "consume"` and the caller's `operationId` from `Idempotency-Key`. Successful
consumption includes `receiptId` and `recordedAt`; denial includes neither field. Allocation rows,
rate-card tiers, purchase actions, internal event IDs and deduction arrays are absent.

Receipt detail is immutable, with operation and caller identity, account/entity scope, exact
quantities, occurred/recorded times, balance after usage, catalog-rating reference and deduction
count. Its deductions are a separate cursor-paginated child collection, default 50 and maximum 100.
An entity receipt requires `?entityId=<external entity ID>` on both reads. Cursors are bound to their
receipt; receipt IDs and cursors are opaque. These reads require project authentication and admit
read-only credentials. The snapshot, event, deductions, billing effect and recovery result commit
in one transaction.

The independently versioned [`@quotum/sdk`](https://github.com/quotumapp/quotum-js) preview uses these
account/entity handles. Its release must pin the exact public API revision containing this contract.
It is distinct from the internal `quotum-api/sdk` client. Reserve/confirm/release, correction and
balance endpoints retain their existing field names and detailed responses until their next
coordinated pre-1.0 increment; the public SDK does not expose placeholder methods for them.

## Reservations and related operations

Quantities are decimal strings. A check is side-effect-free, consume records an immutable receipt,
and reservation finalization is atomic. Usage mutations require `Idempotency-Key`; corrections,
controls, alerts, automatic top-ups, and license assignments also require `X-Billing-Actor`.
Confirming more than the reserved quantity returns `RESERVATION_QUANTITY_EXCEEDED`, a changed
confirmation returns `RESERVATION_ALREADY_CONFIRMED`, and using a newly published meter absent from
the account's purchased catalog returns `METER_RATE_NOT_ACTIVATED`. Omitted `expiresInSeconds` on a
reservation defaults to 300. A reservation's expiry, and whether a correction or confirmation may
still use an allocation, are decided on the database clock, so an application host whose clock
drifts never expires a live hold or refuses a valid refund. An open reservation keeps its hold on
an allocation that ends while it waits (revoked, expired, or a plan allowance that ended): balance
reads, the billing summary and projections keep counting that hold as `held`, and list the
allocation in the breakdown with nothing `available`, until the reservation settles. A confirmation
still consumes from the hold. What a release or a smaller confirmation frees never becomes
spendable again: on an expired allocation it stays expired (and follows the allowance's rollover
rules), and on a revoked operator grant it is revoked too (see [Operator grants](grants.md#operator-grants-and-administrative-debits)).
License pools follow the purchased subscription-item quantity: an
entity license check honors active assignments in assignment order up to that capacity, so a seat
downgrade stops authorizing the assignments beyond it until they are revoked.

## Automatic top-ups

An automatic top-up policy belongs to the account or to one entity. The account's policy keeps the
shared pool topped up: it is evaluated after account usage, and after entity usage that spent some of
the pool, against what is left in the pool, and what it buys goes to the pool. An entity's policy is
evaluated after that entity's usage against everything the entity can spend, its own allocations and
the pool, and what it buys is credited to the entity. One write can trigger both.

## Spending order

Usage spends an account's allocations of a feature in expiry order, the earliest first and
allocations without an expiry last. Entity usage can spend both the entity's own allocations and the
account's shared pool; at equal expiry it spends the entity's own first, so one entity's usage does
not drain credit the others share while its own is still available. Older allocations go first
after that. Account usage without an entity spends the shared pool only.

## Pricing usage

Every subscription pins the catalog revision it was bought from, and the rate card of that
revision prices the account's usage, whatever the catalog publishes later. When an account's
subscriptions pin several revisions that price a meter, such as a base plan bought before a later
revision and an add-on bought from it, the base plan's revision prices the usage: an add-on never
re-prices it. Without a base plan whose revision prices the meter, the newest add-on revision that
does applies, and of several base plans the newest.

A meter priced by a rate card charges its wallet feature once per request, rounded up to the
wallet's `creditScale`. Any positive quantity therefore costs at least one wallet unit: at 0.001
credits per token and a wallet scale of 0, one to 1,000 tokens cost 1 credit. Splitting usage into
smaller requests never lowers a flat rate-card charge. Graduated rate-card tiers apply to each
request's quantity alone and restart on the next request: they do not accumulate over a period, and
splitting usage changes which tiers it reaches. A reservation holds the charge for the reserved
quantity, and confirming that quantity or less never charges more than the hold. A correction
reverses the wallet charge recorded on the original event rather than rating the corrected quantity
again: a partial correction returns its proportional share, rounded to the wallet scale and capped
by what remains, and correcting the rest of the usage returns the remainder, so corrections
together return exactly what was charged. A correction's `quantity` follows the same rule as
consume: it may carry no more decimal places than the meter's `creditScale`, or it answers
`400 INVALID_REQUEST`.

## Meter limits

Meter-limit balances and capped usage remain scoped to the requested entity. Internal and deferred
reservation paths also retain their canonical filter scope; public checks/consumption have no filters.
The canonical filter compares values as text in any key order, so `{ "model": 1 }` and
`{ "model": "1" }`, or `true` and `"true"`, count in one window.
Monetary spend for postpaid overage is rated across every scoped window belonging to the same
subscription, purchased plan item, and billing period, exactly as the usage invoice is rated.
The included allowance and price tiers apply once to that combined quantity. Checks, consumes,
reservations, confirmations, and corrections use this shared monetary scope; selecting another
filter or entity does not create another included monetary allowance.

A meter limit counts usage in a window of its item's reset cadence: `resetInterval`, one of `hour`,
`day`, `week`, `month`, `quarter`, `semi_annual` or `year`, times `resetIntervalCount` (default 1),
so `{ "resetInterval": "hour", "resetIntervalCount": 5 }` is a five-hour window. An allocation
cannot reset hourly and a rollover cannot expire in hours: metering maintenance grants allocations
on its polling cadence and never grants a missed window afterwards. While the provider period is
current, the window is the period, or a reset sub-window of it when the item resets more often than
the plan bills (a monthly limit on an annual plan, a daily or weekly one on a monthly plan).
Sub-windows are anchored at the period start and keep its time of day; the last one is clamped to
the period end, so a weekly limit on a 30-day month ends with a two-day window that still carries
the whole limit. Once a period has ended without a recorded renewal, windows roll on from the period
end one reset interval at a time: a period exactly one interval long keeps its start's day of the
month, so Jan 31 to Feb 28 rolls on to Mar 31, and any other period rolls on its end's day. Day,
week and hour windows are exact multiples of 24 hours, 7 days and 1 hour. Usage recorded at the
exact end of a window counts in the next.

An add-on that caps a feature raises the account's cap: the limits of the account's base plan and
its add-ons on one feature add up within one window. The base plan's limit anchors it: the window,
the overage policy and any overage price are the base plan's (the newest base plan's, should an
account hold several), or the newest add-on's when no base plan caps the feature. An add-on's
limit adds its quantity when both are hard caps (`overagePolicy: "blocked"`) with the same reset,
and counts from the moment the add-on is active. Postpaid overage is invoiced against one item's own
quantity, so a limit that allows it never adds up. Catalog preview and publication therefore refuse
a catalog with `400 INVALID_REQUEST` once an add-on caps a feature that another plan caps with
overage allowed or with another reset, and an add-on purchase whose limits cannot add up with the
ones the account already holds, such as a base plan bought from an earlier revision, is
`ADDON_METER_LIMIT_CONFLICT` (409) with the features in `details.featureKeys`. An account that
still reaches such a combination another way, such as a later base-plan change, keeps its anchor's
limit and the add-on limits that can join it; usage never fails over it. A plan grant, such as a
trial or the default plan, caps alone, and a paying subscription's limit replaces it.

## Spend and usage limits

A usage limit caps the quantity recorded for the feature it names and nothing else: when a rate
card charges a meter's usage to a wallet feature, a usage limit on the meter counts it and one on
the wallet does not. To cap how fast a wallet drains, use a spend limit or a meter limit.

Spend and usage limits (`PUT /controls`, plan `controls`, contract `controls`) and usage alerts
count in UTC calendar windows: `interval` is one of `day`, `week`, `month`, `quarter`,
`semi_annual`, `year`, `hour` or `lifetime`, times an optional `intervalCount` (default 1; none for
`lifetime`). An hour starts on the hour, a day at 00:00 UTC, a week on Monday, a quarter in January,
April, July or October and a half in January or July; a window of several units is counted from the
Unix epoch, so `{ "interval": "week", "intervalCount": 2 }` covers fixed Monday-to-Monday fortnights
for every account and five-hour windows do not restart at midnight. Every window an account uses is
kept as a row of about 450 bytes with its indexes, so an hourly limit adds up to 24 rows a day for
each account that uses it. Windows follow the calendar, not the subscription, and span at most three
years. Controls counted in the same window compete however their cadence is spelled: a contract
`month` × 3 replaces a plan `quarter`. An account or entity holds one limit per kind, feature and
currency, so a new one replaces the previous one whatever its window; stacked windows, such as a
daily and a monthly limit, belong on the plan. A replacing limit keeps counting the window the one
it replaced counted: a new account limit, a republished plan's limit and a contract limit that takes
over from a plan default all start from the usage already recorded in the current window, never
from zero. Open holds count against it too: a reservation taken under the replaced limit keeps its
capacity, settles once against the replacing limit when confirmed and frees it when released or
expired. A correction of usage counted before the replacement lowers the replacing limit's count as
well. `GET /controls` reports each limit's `windowStartAt`
and `windowEndAt` (both `null` for `lifetime`). A percentage alert follows the usage limit counted
in its own window, and a hold stays in the window it was taken in: confirming after the window rolls
charges the earlier window.

A usage alert counts its window from the window's start: a new alert starts from the usage already
recorded in the current window, and if that usage has already reached the threshold, the alert records
its `threshold_crossed` event when it is created. A correction counts in the window of the usage it
corrects. After that window has ended, the correction does not change the alert's current count.
Once a window has ended, `GET /usage-alerts` reports `currentValue` 0 and `crossed` false until
usage opens the next window.

Spend-control activation and window boundaries use the database clock by default, so API clock
skew cannot bypass a newly active policy. Spend controls rate committed usage independently of pending reservations: held quantities never
unlock volume discounts on consumed usage. A monetary reservation hold is a fixed budget quote,
released on confirmation, release, or expiry. For volume pricing it covers the highest charge over
all partial quantities up to the reservation at the current committed usage, including intermediate
tier boundaries. Separate quotes can conservatively reserve more than the combined eventual charge.
Confirmation rerates actual committed usage and checks the cap again; intervening usage or a
correction can therefore make confirmation return `control_limit_exceeded`. A denied confirmation
keeps its reservation active and can still be released. A new confirmation after conditions change
uses a new idempotency key; replaying the denied operation returns its recorded denial.

## Usage reads

Usage reads default to the last 30 days, reject ranges over 90 days, and page with an opaque cursor
(default 50, maximum 200). Series support `hour` or `day` buckets. These reads and `billing-summary`
never authorize work; product projections are display caches and cannot replace the metering calls.

## Usage operation recovery

Consume, reserve, confirm, release, and correction are recoverable under the caller-owned
`Idempotency-Key`, scoped to `(projectInstanceId, billingAccountId, operation kind, key)`. After a
timeout, lost response, `5xx`, or restart, retry with the same key and input: same-input replay
returns the original result, including a denial; different input returns `409 IDEMPOTENCY_CONFLICT`.
Keep `occurredAt` stable across retries and put per-attempt tracing in headers. Deferred reservation
and correction inputs still accept metadata, which also participates in their fingerprint.

```http
GET /v1/billing-accounts/:billingAccountId/usage/operations/:operation/:operationId
```

returns `operation`, `operationId`, `status`, `completedAt`, and a compact `outcome`. The SDK exposes
it as `account.getOperation` or `entity.getOperation`; the bundled client uses `client.usage.getOperation`.
For new consume operations, `outcome` is exactly the original compact command result. Entity-scoped
lookup requires `?entityId=...`. Retained consumes from the older response contract return
`OPERATION_RESULT_EXPIRED` through the new HTTP contract; do not replace their operation key.

- `409 OPERATION_IN_PROGRESS`: another transaction owns the operation; retry the same input.
- `409 OPERATION_RESULT_EXPIRED`: the identity is retained but its result is gone; do not mint a new
  key to repeat the charge.
- `404 OPERATION_NOT_FOUND`: no retained identity; after an uncertain request retry only the original
  key.

Outcomes are retained for at least 24 hours and identities for at least seven days. Stored outcomes
are limited to 64 KiB. New consume results are constant-size and omit allocation provenance.
For deferred operations and internal callers still returning detailed results, when a result with
the full balance breakdown would exceed that, which takes
about 150 live allocations of the feature, the result's `balance.breakdown` lists only the
allocations the operation changed. The first response and every replay answer that same result, its
totals stay exact, and `GET .../balances/:featureKey` still lists every allocation. Only a result
whose changed allocations alone exceed the bound, such as one consume spread over hundreds of
allocations, fails with `500 OPERATION_OUTCOME_TOO_LARGE` and rolls back the whole mutation.
