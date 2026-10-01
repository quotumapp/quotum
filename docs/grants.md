# Trials, default plan and operator grants

- Document kind: Current behavior

A plan grant gives an account a plan's published version without a provider, a payment method or an
invoice: a [trial](#trials) for a fixed time, or the catalog's [default plan](#default-plan) with no
end. [Operator grants and administrative debits](#operator-grants-and-administrative-debits) are
the audited support credit and clawback.

## Trials

Stripe runs the trials a plan declares with `trialDays`, and App Store and Play run their own free
trial offers; Quotum records those ([providers](providers.md#projections)). A trial Quotum runs
itself needs no provider and no payment method. It is a plan grant: the account holds the plan's
published version for a fixed time, with its entitlements, its allowances and its meter limits,
and no invoice. The trusted backend manages it with project authentication:

```http
POST /v1/billing-accounts/:billingAccountId/trials
GET  /v1/billing-accounts/:billingAccountId/trials
GET  /v1/billing-accounts/:billingAccountId/trials/:trialId
POST /v1/billing-accounts/:billingAccountId/trials/:trialId/end
GET  /v1/billing-accounts/:billingAccountId/trial-eligibility?planKey=:planKey
```

`POST .../trials` takes `planKey`, an optional `durationDays` (1-730) and optional `metadata`
(at most 4 KB), with an `Idempotency-Key`; `X-Billing-Actor` is optional and defaults to the
billing account. Without `durationDays` the plan's `trialDays` applies, and a plan without one
returns `TRIAL_DURATION_REQUIRED`. It creates the customer when needed and returns `201` with the
trial, or `200` with `duplicate: true` when the key is replayed; reusing the key with other terms
returns `IDEMPOTENCY_CONFLICT`. Only the plan's active, published, public version of a base plan
without licensed quantities or entity-scoped allocations, other than the catalog's default plan,
can be trialed (`TRIAL_PLAN_NOT_ELIGIBLE`); an unknown plan returns `BILLING_PLAN_NOT_FOUND`. A
trial supersedes the account's default plan, which returns when the trial ends. An account is
refused a trial while it has another active base trial (`TRIAL_ALREADY_ACTIVE`) or a funding paid
base subscription (`TRIAL_BASE_PLAN_ACTIVE`), and gets one trial per plan: a plan it trialed
through Quotum, or through a provider subscription that recorded trial bounds, returns
`TRIAL_ALREADY_USED`. The error `details` name the `planKey`.
`GET .../trial-eligibility` runs the same checks without creating anything and reports
`eligible`, the refusing `reason` and the plan's `defaultDurationDays`.

During the trial:

- Entitlements come from the keys of the version's published provider bindings, copied when the
  trial starts, with `metadata.source: "plan_grant"`, the `planKey`, the `planGrantId` and the
  trial bounds. A paid source for the same key always wins.
- Allocation items give an allowance in each reset window, anchored at the trial start and clamped
  to its end. The account's first write in a window records that window's allowance as a reward
  allocation; until then balance reads and checks count it in full. A reset needs no worker and
  sends no projection, and no allowance outlives the trial.
- Meter limits apply with overage blocked, in windows anchored at the trial start and clamped to
  its end, and plan-default controls apply. Rate cards, add-on purchases and license pools still
  need a paid subscription.

A trial ends one of three ways, and access stops at that moment without waiting for a worker:

- At `endsAt`: the worker records it `expired` and delivers an `expiry_reconciliation` projection
  with `trial: {event: "ended"}`. About three days before, it sends one `trial: {event: "ending"}`
  fact.
- `POST .../trials/:trialId/end`, with an optional `reason` and an `Idempotency-Key`, ends it early
  (`ended`), expires its allowances and delivers a stored `usage_changed` projection with the
  `ended` fact. Ending a trial that is no longer active returns `TRIAL_NOT_ACTIVE`.
- A paid base subscription from any provider supersedes it as soon as Quotum records the
  subscription (`superseded`, with `supersededBy`). Its allowances expire, the subscription's
  entitlements and limits take over, and no trial fact is sent, since the customer converted.

A trial start delivers a stored `usage_changed` projection keyed `plan_grant:<id>:started`, which
reaches the receiver even when usage deliveries are off. The one-trial-per-plan rule also holds at
checkout: Stripe Checkout leaves out a plan's trial for an account that has had one. Trial reads work with a read-only
credential. Grants carry no channel restriction; follow the store rules for the apps you unlock
them in.

## Default plan

When the published catalog marks a default plan (see
[Catalog publication](catalog.md#default-plan)), every account without a paid base plan holds it, with
no provider, payment method or invoice. Like a trial, it is a plan grant (`origin: "default"`), but
with no end:

- A new account starts on it when Quotum first records the account, whether through a consume, a
  reservation, a checkout, a trial start or a provider event. The account gets a stored
  `usage_changed` projection keyed `plan_grant:<id>:started`.
- Its entitlements carry the keys declared on the marker, with
  `metadata: { source: "plan_grant", origin: "default", planKey, planGrantId }` and a null
  `expiresAt`.
- Its allowances reset in windows anchored at the moment the account first held it, and are
  recorded as a trial's are: by the account's first write in each window. An account that never
  spends costs no allowance rows. Its meter limits apply with overage blocked, and its plan-default
  controls apply.
- A paid base plan from any provider, a funding subscription recorded before plan versions, or a
  trial supersedes it, and its allowances stop at that moment.
- When the account's last base plan ends (expiry, cancellation at period end, refund, revocation or
  the end of a trial), it falls back to the default plan. The new grant keeps the anchor of the
  account's previous default-plan grant and takes over what that grant left in the windows still
  running, so falling back within a window resumes it instead of refilling it, and its meter limits
  keep counting the same window. The projection that records the ending also carries the default
  plan's keys.

A publish that changes the default plan changes the accounts that hold it, in the background.
- **The plan is republished with a new version:** each grant moves in place. Its meter limits
  switch to the new version immediately. Allowances already issued for the current window stay,
  and the new quantities apply from the next reset; a feature the new version adds is granted now,
  and one it drops ends now. Changing an allowance's reset never refills a window either: the
  allowance issued for the current window runs to that window's end, and the new reset's quantity
  starts there, in a first window that ends where the new reset's window does. A weekly allowance
  of 200 with 169 used that becomes monthly keeps its 31 until the week ends; the monthly 200 then
  applies until the monthly window ends, and every later window is a whole month. A feature an
  earlier version dropped within the current window and a later one adds back on the same reset
  resumes what was left of that window's allowance, with its use kept, instead of being granted
  again. An open reservation on it counts once: until the account's next usage write reopens the
  allowance, reads already show it reopened, with that hold, rather than the ended row beside it.
- **The declared keys change:** the entitlements follow them.
- **The marker is removed:** the grants end. Marking it again resumes the windows still running,
  as a fallback does.
- **A default plan is marked for the first time:** existing accounts without a base plan start
  holding it.

Each changed account gets a stored `usage_changed` projection. `impact.defaultPlanAccounts`
reports how many accounts the pass covers. An account whose change fails is left behind and
recorded on the pass (see [operations](operations.md#default-plan-passes)), and the pass moves on.

Reads never write, so they answer an account as its next write will leave it. An account that
would start the default plan on that write reads as if it already held it. That is an account
Quotum has not recorded yet, and a recorded one the pass has not reached or whose last base plan
ended moments ago, such as a trial the worker has not recorded as expired yet. For such an account:
- `check` and `GET .../balances/:featureKey` report the default version's allowance of the feature
  in the current window, or what the previous default-plan grant left of it, and its meter limit
  in the window it would count; `check` also applies the default version's usage limits, against
  windows that hold nothing yet for an account Quotum has not recorded;
- `GET .../entitlements` reports the marker's keys, active, with
  `metadata: { source: "plan_grant", origin: "default", status: "active", planKey }` and no
  `planGrantId`;
- the billing summary counts the same allowance, also for an account Quotum has not recorded,
  which it reports with `customerExists: false`;
- `GET .../controls` lists the default version's controls, with nothing counted yet for an account
  Quotum has not recorded. Without a default plan, or with an `entityId`, such an account still
  answers `404 BILLING_ACCOUNT_NOT_FOUND`.

An account whose default plan a publish changed reads the same way before the pass reaches it: at
the version its next write moves it to, with that version's meter limits, usage limits and the
marker's current keys, without the allowances that move ends, and with the allowance of a feature
the version adds or resets on another interval. Once the marker is removed, it reads without the
default plan: none of its allowances, limits or controls, and its keys inactive with
`metadata.status: "ended"`. A key the marker drops reads inactive with `status: "inactive"`, since
the grant runs on without it (see [Projections](providers.md#projections) for inactive
entitlement metadata).

Its next write first records what the read assumed: it starts the default plan, records an elapsed
trial, or applies a changed default plan, so the write sees what the read reported. The default
plan's controls apply to that write too, including the first one that starts the plan. A product that
checks before it consumes therefore admits a new free user at once.

A balance counts an allowance no write has recorded in `granted` and `available`, but its
`breakdown` lists only recorded allocations. Such an allowance has no `allocationId` until the
account's next write in its window, so an administrative debit cannot target it before then.

A breakdown entry's `sourceKey` names what created the allocation, for a plan grant
`plan_grant:<grantId>:<planItemId>:<window>`, and never changes: the key is what keeps the
allocation from being created twice. An allowance that a later grant resumes within its window,
when an account falls back to the default plan or a newer version adds back a feature an earlier one
dropped, keeps its key, so its `sourceKey` can name an earlier grant and plan item.

## Operator grants and administrative debits

Support credit and clawback are audited operator operations. They are not usage corrections or
promotions, which would misstate what happened:

```http
POST /v1/admin/operator-grants/:billingAccountId
GET  /v1/admin/operator-grants/:billingAccountId
GET  /v1/admin/operator-grants/:billingAccountId/:grantId
POST /v1/admin/operator-grants/:billingAccountId/:grantId/revoke
POST /v1/admin/administrative-debits/:billingAccountId
GET  /v1/admin/administrative-debits/:billingAccountId
```

Every route needs the operator key, including the reads, so a read-only credential is refused.
Mutations also need `X-Billing-Actor` and an `Idempotency-Key`, and each takes a `reason` (1-500
characters). A replayed key returns `200` with `duplicate: true`; reusing it for other terms returns
`IDEMPOTENCY_CONFLICT`. Keys are scoped to the billing account, so a revocation key already used on
one grant conflicts on another.

- **Grant.** `POST .../operator-grants/:billingAccountId` takes `featureKey`, a decimal `quantity`,
  an optional `entityId` and an optional future `expiresAt`. It gives the account one allocation
  with `sourceKind: "operator"`, spent in the usual order, and never records a payment. The feature
  must be a consumable that usage spends: a rate card's wallet, or a feature a plan allocates that
  no published rate card prices as a meter. A meter a rate card charges to its wallet, a
  consumable nothing prices, or a boolean or non-consumable feature answers
  `OPERATOR_GRANT_FEATURE_INVALID`; a key that names no active feature answers
  `404 FEATURE_NOT_FOUND`. The quantity must fit its
  credit scale. It creates the customer when needed and returns `201` with the grant. A grant
  carries its allocation's consumed, held, reversed and available quantity, and its `status` is
  `active`, `expired` or `revoked`. A feature that the account's plan caps with a meter limit is
  metered against that limit's window, so a grant of it has no effect while the limit applies.
- **Revoke.** `POST .../:grantId/revoke` takes back what the grant still gives: quantity that is
  unconsumed, unheld and unexpired. Consumed usage stays consumed, and an open reservation still
  confirms from its hold, which balance reads keep showing as `held` until it settles. Whatever a
  release, an expiry or a smaller confirmation later frees from that hold is revoked as well: it
  is added to the grant's `reversedQuantity` and `revocation.revokedQuantity`, and never becomes
  available. `revocation.revokedQuantity` reports what the revocation took, which leaves out
  anything an earlier debit already took; an expired grant reports `0`. A usage correction whose
  refund would go back to a revoked grant answers `409 CORRECTION_TARGETS_REVOKED_GRANT`, since the
  customer would get nothing back. A second revocation with another key returns
  `OPERATOR_GRANT_ALREADY_REVOKED`.
- **Debit.** `POST .../administrative-debits/:billingAccountId` takes `allocations`, 1-20 of
  `{allocationId, quantity}` (ids from a balance breakdown), all applied or none. A debit raises
  each allocation's reversed quantity and writes no usage event, so the balance breakdown shows
  it as `reversed` and never as `consumed`. An allocation must belong to the account
  (`ALLOCATION_NOT_FOUND`) and be live. A purchase or top-up allocation is refused
  (`ALLOCATION_NOT_DEBITABLE`, `reason: "provider_purchase"`), because purchased credit is taken
  back by refunding it through the provider. A quantity above an allocation's available quantity
  returns `ADMINISTRATIVE_DEBIT_EXCEEDS_AVAILABLE`, and the error `details` carry the
  `allocationId` and its `available` quantity. A debit needs an existing account
  (`BILLING_ACCOUNT_NOT_FOUND`).

The two lists, `GET .../operator-grants/:billingAccountId` and
`GET .../administrative-debits/:billingAccountId`, page newest first with `cursor` and `limit`
(default 25, at most 100). A `reason` counts characters, so 500 emoji fit. Every `/v1` list reads
its `limit` in decimal digits only: `0x2`, `1e1` or `2.0` answer `400 INVALID_REQUEST`.

Each change enqueues the coalesced `usage_changed` projection, as promotion grants do. A revoked
promotion reward reports only the quantity its revocation took, net of an earlier debit. A grant,
revocation or debit replayed with its `Idempotency-Key` returns the original result, attributed to
the actor who made it, whatever `X-Billing-Actor` the replay sends: the actor records who acted and
is not part of the request a key identifies.
Balances cannot be set to a value, and usage counters or reset times cannot be edited.
