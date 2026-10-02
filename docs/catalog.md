# Catalog publication

- Document kind: Current behavior

Operators submit one complete intent to `POST /v1/admin/catalog/preview` and then
`POST /v1/admin/catalog/publish` with the preview token and expected revision; both require project
and operator authentication plus `X-Billing-Actor`. Provider bindings adopt pre-provisioned store
products and must all be ready before the active pointer advances. Previously active features,
plans, and top-ups must be retained or listed explicitly for retirement; omission is not deletion.
Retiring a plan removes it from new selection without rewriting pinned subscriptions.
`GET /v1/admin/catalog` returns the active intent and needs project authentication only. It
returns the [canonical intent](#canonical-intent), with every default spelled out and `tiers: []`
on a flat price or rate card, and the hash of that canonical intent. Preview accepts that output
unchanged, and previewing it reports the same `intentHash` with no features, plans or versions
created. A revision keeps the hash recorded when it was published; the read-back hash is
recomputed from the stored intent, so it can differ from the recorded one for a catalog published
before the canonical intent. See [`examples/quickstart/catalog.json`](../examples/quickstart/catalog.json)
for a minimal intent.

## Canonical intent

Preview stores and hashes the canonical intent, and publish compares the canonical intent of what
it is sent with the preview's. A plan has two price blocks, and a plan with neither, whose items
carry no price either, is unpriced:

- `basePrice` is a price Quotum models and charges through a Stripe price component.
- `providerPriced` holds the products whose price their provider owns: App Store and Google Play
  products, and Stripe products priced in the Stripe dashboard. It has a `billingInterval`
  (required), a `billingIntervalCount` and its `providerBindings`, and no amount. When a plan has
  both blocks they bill on the same cadence, and a binding appears in only one of them. The plan's
  products are both blocks' bindings together, so a subscription to any of them finds the plan.
- A plan's currency is its `basePrice`'s. A plan priced only by its items, such as a seat-only plan
  or a meter limit with priced overage, records no plan currency or amount; each item price keeps
  its own currency, which is what Checkout and invoicing charge. Its billing cadence is the one its
  item prices share.

A plan item takes only the fields of its `itemKind`:

| Kind | Fields |
| --- | --- |
| `access` | `featureKey` |
| `allocation` | `featureKey`, `quantity`, `reset` (`{ interval, intervalCount }` or null), `expiry`, `allocationScope` (`account` or `entity`), `rollover` |
| `meter_limit` | `featureKey`, `quantity`, `reset` (required), `overage` (`{ "policy": "blocked" }` or `{ "policy": "allowed", "price": … }`), `allocationScope` (`account` or `entity`) |
| `licensed_quantity` | `featureKey`, `quantity`, `price` (required), `allocationScope` (`account` or `license_pool`) |

An allocation or top-up `expiry` is `{ "mode": "forever" }` or
`{ "mode": "after_seconds", "seconds": 86400 }`. In what preview accepts, `reset` on an
allocation, `expiry`, `allocationScope`, `rollover` and `overage` may be left out and default to
null, `forever`, `account`, null and `blocked`; plan defaults such as `kind`, `visibility` and
`controls` are optional too.

Until the 1.0 release candidate preview and publish also accept the legacy spelling: the
plan-level `currency`, `baseAmountMinor`, `billingInterval`, `billingIntervalCount` and
`providerBindings`; item `resetInterval`, `resetIntervalCount`, `expiresAfterSeconds` and
`overagePolicy`; and a top-up's `expiresAfterSeconds`. A legacy plan with a `basePrice` keeps it
as its `basePrice`, and its plan-level bindings that `basePrice` does not hold become its
`providerPriced` products, on the plan's cadence. A legacy plan without a `basePrice` whose
plan-level bindings name products is provider-priced, and must then have a `billingInterval`; its
`baseAmountMinor` and `currency` are dropped, because the provider owns that price. On a plan with
neither a price nor a binding, `baseAmountMinor`, `currency` and `billingInterval` charge nothing
and are dropped too. A legacy access item must have a null quantity, reset and expiry and a blocked
overage. Spelling a catalog either way yields the same canonical intent and hash.

A preview reports what it accepted in the legacy spelling in `deprecations`, one entry per plan,
item or top-up: its `path`, the `legacy` fields it used, the `canonical` fields that replace them
and a `message`. It reports `advisories` separately: valid shapes worth reconsidering, which never
imply removal. The one advisory is a Stripe binding in `providerPriced`: "Use `basePrice` when
Quotum should model the price." Provider-owned Stripe pricing has no retirement plan.

The SDK's `defineCatalog`, the CLI's catalog files and `client.catalog.preview` and `publish` take
either spelling; `client.catalog.status` and the MCP `get_catalog` tool return the canonical intent.

## Validation

Preview and publish validate the intent's structure first and reject the first structural problem,
including a binding on the wrong channel, with `400 INVALID_REQUEST`. That includes a meter limit or
allocation whose reset window cannot fit every billing period, such as `resetInterval: "year"` on a
`billingInterval: "month"` plan or 29 days on a monthly plan (February is 28): windows and grants
reset with every provider period, so the yearly quantity would silently become a monthly one. It
also includes a plan item quantity or rollover `maxQuantity` with more decimal places than its
feature's `creditScale`, which a top-up's quantity may not have either. A reset spans at most three
years, `resetIntervalCount` is a whole number from 1 to 1,000 and needs a
`resetInterval`, and `overagePolicy: "allowed"` needs a reset of a month or longer, because postpaid
overage is invoiced once per closed window; a daily or weekly meter limit is a hard cap. A rollover
expiry is `{ "mode": "after", "interval": "week", "intervalCount": 2 }` or `{ "mode": "forever" }`
and spans at most ten years; the earlier `{ "mode": "months", "months": 3 }` is still accepted and
is returned as `after` with a month interval. A plan bills every `billingInterval` (`day`, `week`,
`month`, `quarter`, `semi_annual` or `year`) times `billingIntervalCount` (default 1, at most three
years), and every price on it recurs at the same interval however it is spelled: `quarter` and
`month` × 3 agree. Only then do they check each provider binding against
its provider's capability declaration: a plan with a trial, an add-on plan, every explicit price
component (`basePrice` or an item `price`), and every top-up need the matching `catalog.*`
operations (a top-up needs `catalog.topup`). Every plan-level or price binding of a plan with a
billing interval also needs its provider to sell that interval (the billing intervals listed under
[Provider capabilities](providers.md#provider-capabilities)): an App Store product cannot renew every
four months, so a verdict on `catalog.product.subscription` blocked at the `provider` layer with
reason `BILLING_INTERVAL` names the interval. All incompatible bindings are reported together as one
`400 PROVIDER_CAPABILITY_UNSUPPORTED` whose `details.providerCompatibility` lists them in catalog
order; see [Provider capability errors](provider-capabilities.md#provider-capability-errors). The whole submitted intent is
checked, including the plans it keeps unchanged. The published catalog is never re-validated
against the declarations, the reset-interval rule or the price rules below: it stays readable, and
preview still compares a new intent against it. Publish checks reset intervals, prices and
capabilities after it finds the preview token, so retrying a publish that already succeeded returns
its stored result with `duplicate: true`. A successful preview also reports `providerCompatibility`;
see [Catalog preview compatibility](provider-capabilities.md#catalog-preview-compatibility).

A legacy plan can spell its price twice: the plan-level `currency`, `baseAmountMinor`,
`billingInterval`, `billingIntervalCount` and `providerBindings`, and the `basePrice` object. When
a plan has a `basePrice`, every plan-level value it also sends must agree with it, or preview and
publish answer `400 INVALID_REQUEST` naming both values, such as `Plan pro baseAmountMinor 1000
conflicts with basePrice unitAmountMinor 2000`. A plan-level binding conflicts when it binds a
provider channel that `basePrice` also binds to a different product; App Store and Google Play
products whose price the store owns, on channels the `basePrice` does not bind, are its
`providerPriced` products. A plan sending `providerPriced` cannot also send the plan-level fields.
A price on an `allocation`, or on a `meter_limit` whose overage is blocked, is refused too:
Checkout leaves metered prices out, and usage invoicing and metering read an overage price only for
an `allowed` limit, so such a price would show in the plan's pricing and never be billed. A plan
may have no items. A catalog published before these rules keeps working as it was published, and
reads back in the canonical spelling, which has no place for a price that never charges; previewing
the stored legacy intent unchanged is refused until the conflicting value or the unbilled price is
removed.

A plan's base price is its amount and currency together: a plan version records a currency only
with a `baseAmountMinor` or a `basePrice`. A plan priced only by its items, such as a seat-only plan
or a meter limit with postpaid overage, may still name `currency` for its item prices, which must
use it, but publishes no base price; each item price keeps its own currency on its price component,
which is what Checkout and invoicing charge. A `baseAmountMinor` without a `currency` is refused
with `400 INVALID_REQUEST` (`Plan team baseAmountMinor requires a currency`).

## Allowance windows

An allocation that resets more often than its plan bills, such as `resetInterval: "month"` on an
annual plan or `"week"` on a monthly one, grants its quantity once per reset window, anchored at the
provider period start in UTC. A plan version with no billing cadence, such as an unpriced plan,
bills by the period the subscription recorded: a reset shorter than that period splits it the same
way, for allowances and meter limits alike. Month-end anchors clamp to the shorter month and recover their
original day afterwards; the last window stops at the provider period end and grants the whole
quantity. Its expiry is the earlier of that boundary and `expiresAfterSeconds` after the window
start. Provider synchronization grants the current window and metering maintenance grants later
windows on its normal polling cadence. Reads do not create grants. After downtime only the current
window is granted; elapsed windows are not reconstructed. Existing rollover rules still apply to
allocations that were actually issued. Grants use the subscription's pinned plan version and
account/entity scope, and stop when its recorded period or access ends. Period-end cancellation
continues grants while access remains valid.

An allocation with neither `resetInterval` nor `expiresAfterSeconds` is a lifetime allowance: a
subscription is granted it once, in its first period, and keeps it across renewals instead of
receiving the quantity again every period. It ends with the version, at a switch to another one,
and a return to the version resumes it with its use kept, as the
[plan-change rules](subscriptions.md#allowances-across-a-plan-change) describe.
A subscription that already held such an allowance granted per period, before lifetime allowances
existed, keeps what it has and is not granted another.

## Default plan

A catalog may mark one plan as its default with
`"defaultPlan": { "planKey": "free", "entitlementKeys": ["free_tier"] }`. An account that has no
paid base plan holds the default plan's published version with no provider involved, the way it
holds a trial. The marked plan must be an active, public base plan that is unpriced (no
`basePrice`, no `providerPriced` products and no item price) and has no trial days. It cannot hold licensed quantities,
entity-scoped allocations or rollover, and each of its allocations must reset. A violation returns
`400 INVALID_REQUEST`. An unpriced plan has no provider product, so its entitlement keys are
declared on the marker (at most 100). A marker key may also be one a paid plan grants, such as a
`basic` key held on both the free and the paid plan; publication does not refuse it. Changing or
removing the marker creates no plan version.
Preview and publish report `impact.defaultPlanAccounts`: the accounts the default plan covers,
meaning those without a funding subscription to a base plan (or to no plan version, as recorded
before plans existed) and without an active base plan grant such as a trial. A publish that removes
the marker reports the accounts that lose the default plan, counted the same way, and one without a
marker before or after it reports `0`, as does a revision published before this field existed. How
accounts hold it is described under [Default plan](grants.md#default-plan).

## Catalog as code

The same contract is available as code:

```sh
export BILLING_BASE_URL=https://billing.example.com
export BILLING_PROJECT_API_KEY=...
export BILLING_OPERATOR_API_KEY=...
export BILLING_ACTOR=deploy@example.com

bun run catalog status
bun run catalog diff ./billing.catalog.ts
bun run catalog push ./billing.catalog.ts
```

The image runs the same commands as `quotum catalog status|diff|push`; mount the catalog file into
the container to diff or push it. `status` needs only the base URL and a project key; `diff` and
`push` also need the operator key. The file exports its intent as `catalog` (or the default export)
and may export `expectedRevision`: a revision number to publish only over that revision, or `null`
to publish only while no catalog is published. Without the export, `diff` and `push` expect the
current revision. `diff` compares canonical intents, so a file that spells the published catalog the
legacy way still reports `changed: false`.

## Catalog migrations

An applied catalog migration settles once when the subscription is synchronized. Later updates,
including an explicit downgrade or a provider-side return to an earlier plan, cannot replay that
historical migration. Stripe subscription-item IDs can remain unchanged across plan versions;
Quotum transfers their live association to the target price component and retains the inactive
source component rows and existing license-pool references. Returning to an earlier version reuses
its component rows.
