# Upgrade transitions

- Document kind: Current behavior
- Sources: [migrations](../migrations), [migration runner](../src/migrate.ts).

Before 1.0 the baseline migrations evolve in place under the
[schema and upgrade policy](operations.md#schema-and-upgrade-policy), so a populated deployment
moves to a changed baseline by restoring its data into a freshly migrated database. The
[stored job provider identity](#stored-job-provider-identity) section gives that procedure in full;
the later sections name the steps they reuse and add what their own change needs. A release's pull requests name the baselines it changes under
`Upgrade notes`.

## Upgrading a populated deployment to v0.22.0

v0.22.0 adds the common Paddle checkout and changes two baselines relative to v0.21.0:

- `migrations/002_billing_core.sql` adds `paddle_checkout_reservations`, with one open reservation per
  project/billing account and retained closed-owner history.
- `migrations/003_metering_and_pricing.sql` adds
  `commercial_action_previews.provider_context`, a non-null JSON object with default `{}`. It stores
  the private Paddle connection, price and plan snapshot; the public response never includes it.

Keep the matching Drizzle mirror and generated contracts with the runtime. No environment
variables change. Recreate disposable databases. For a populated v0.21.0 database:

1. Stop API traffic and workers; take and verify a backup. Migrate an empty database and restore
   data using the [stored job provider identity](#stored-job-provider-identity) procedure. Skip its
   provider-column relaxation/backfill because v0.21.0 already has those columns. Never edit
   recorded checksums. Restore older previews with the new column's default `{}`; Stripe previews
   remain usable, while invalid unfinished Paddle previews fail stale. Preserve any already-present
   valid Paddle context and completed result when upgrading an earlier follow-up build.
2. Before starting the runtime, inventory **every** retained Paddle `checkout.hosted` operation
   whose status is not `failed`, grouped by project/billing account. Reconstruct reservation history
   for every such operation, including already fulfilled/canceled checkouts. Copy project, account,
   provider-account identity, connection version, provider idempotency key and operation ID from the
   receipt; derive `target` as `{binding: request.bindings[0], plan: request.plan ?? null}`. Use
   `owner_kind = commercial` and its preview token only for an account/project-matching Paddle
   preview whose provider key equals `commercial:<previewToken>`; otherwise use `direct` and a null
   preview token. Preserve original timestamps and validate the retained binding/plan shape against
   the runtime schemas; do not substitute current catalog or connection values.
3. Mark a reconstructed row `fulfilled` only with committed correlated purchase/subscription
   evidence, or `canceled` only after an authenticated read through its recorded connection proves
   cancellation and matches the receipt's customer, transaction and correlation. Store a non-null
   `closed_at` with that reason and retain the evidence with the upgrade record. Otherwise leave
   both closure columns null. **A succeeded create receipt is not payment or cancellation proof.**
   Prepared, uncertain and review-required operations need open holds until resolved. Multiple
   potentially payable operations for one account require explicit provider reconciliation before
   constructing the unique open hold; do not choose one and discard the others. If any snapshot or
   proof cannot be reconstructed, keep checkout traffic disabled and reconcile it before proceeding.
4. Verify that every nonfailed historical checkout operation has a matching reservation and that
   every account has at most one open row. The runtime fails closed with
   `PADDLE_CHECKOUT_PENDING` on new keys when retained nonfailed operations lack reservation history;
   existing completed receipts still replay. This guard is not a substitute for the stopped restore.
5. Retain referenced encrypted connection versions. Add `transaction.canceled` to the existing
   notification setting without changing its identity, verify signed delivery, and verify counts,
   foreign keys and migration status before enabling traffic and workers. Replay pending provider
   notifications after startup; do not release unknown reservations by age or preview expiry.

**Skipping releases and calendar months.** An upgrade that skips releases follows this procedure
once: run each skipped release's pre-checks (for example the Apple provider-row check in the v0.20.0
section), migrate an empty database with the target image and restore the data; the intermediate
releases' stopped-service steps are not repeated. The baseline creates the monthly `usage_events`
partitions from the month before it runs, so a database migrated in a different calendar month than
the dump can lack a partition the dump lists, and `pg_restore` then stops with a missing relation.
Before restoring, compare the dump's `usage_events_YYYY_MM` data entries with the migrated
database's partitions. If an entry has no partition and the old partition held no rows, drop its
`TABLE DATA` line from the restore list; if it held rows, stop and create the partition first.

Step 2 above assumes a v0.21.0 source. From an older source the `provider_operations` table does
not exist, so there is nothing to inventory: confirm that the source has no Paddle connection, then
skip steps 2 and 3 and continue at step 4. Restored OAuth clients keep their old scopes, because
the restore replaces the newly seeded clients with the old rows. Add the billing-write scope only
through the opt-in [enabling MCP proposals](#enabling-mcp-proposals-after-the-upgrade) step.

Rollback restores the pre-upgrade backup with the old binary and loses subsequent writes. Sandbox
checks qualify the new behavior, not a populated production upgrade; rehearse the transformation
and reconciliation against a restored copy before scheduling downtime.

## Upgrading a populated deployment to v0.21.0

v0.21.0 combines sandbox Paddle and browser-approved MCP proposals. All four baselines change:

- `migrations/001_platform.sql`: admits the encrypted `paddle` connection kind.
- `migrations/002_billing_core.sql`: admits Paddle billing facts and adds `provider_operations`,
  immutable intent, lease/state checks, retry scheduling and append-only operator review requests.
- `migrations/003_metering_and_pricing.sql`: admits Paddle in general provider-bound billing tables.
  Legacy checkout receipts and unsupported promotion shapes keep their narrower provider sets.
  It also adds `billing_administration_receipts` for idempotent browser-approved mutations.
- `migrations/004_merchant.sql`: adds `platform_mcp_changes`, persisted authorization scopes and
  the optional billing-write scope on seeded OAuth clients.

Recreate disposable databases and apply all migrations. Move a populated **v0.20.0** deployment in
one stopped-service transition:

1. **Stop the whole old service**, including API, webhooks, merchant application and workers.
   Preserve the connection encryption keys and every referenced encrypted connection version;
   Paddle recovery uses the recorded validated active or retired version, not its replacement.
2. **Back up, migrate and restore** using steps 1, 2 and 4 of
   [stored job provider identity](#stored-job-provider-identity): take a custom-format backup,
   migrate an empty database with the v0.21.0 image, delete its seeded OAuth clients, then restore
   data with triggers disabled and without the old migration history. Skip that procedure's
   provider-column relaxation/backfill: v0.20.0 already stores those columns. Never edit recorded
   migration checksums or run the revised baselines against the populated old database.
3. **Verify before starting.** Compare every existing table's row count with the source and run
   `quotum migrate status`. The new `provider_operations`, `billing_administration_receipts` and
   `platform_mcp_changes` tables start empty. Restored MCP authorizations receive the default
   `["quotum.read","offline_access"]` scopes; existing OAuth clients and grants retain their
   access. Check these separately from the preserved billing and Apple promotion records.
4. **Start v0.21.0 with MCP writes disabled.** Leave `QUOTUM_MCP_WRITES_ENABLED` unset or `false`,
   then verify `/ready` and the application's normal billing and projection flows. Paddle is
   sandbox-only; configure its sandbox connection and mappings separately using
   [the provider guide](providers.md). `BILLING_TEST_PADDLE_*` settings belong only to guarded test
   entrypoints, not the production service.

For seat-only plans published before the fix, publish a new plan version to create the missing
binding; publishing an unchanged plan does not repair it. The affected subscription adopts its
bound version on the next Stripe event. See [catalog](catalog.md) and [subscriptions](subscriptions.md)
for the binding rule. The carry-over fix preserves existing records and corrects subsequent
calculations; it does not rewrite historically miscounted allowances.

A rollback restores the pre-upgrade backup with the v0.20.0 image and loses subsequent writes.

### Enabling MCP proposals after the upgrade

This is a separate opt-in after matching merchant UI/BFF review and decision routes are deployed.
The data restore replaces newly seeded OAuth clients with the old rows. Before requesting write
consent for the built-in clients, add the allowed scope without changing existing grants:

```sql
UPDATE platform_auth_oauth_clients
SET scopes = array_append(scopes, 'quotum.billing.write'), updated_at = now()
WHERE client_id IN ('quotum-claude-code', 'quotum-cursor')
  AND NOT ('quotum.billing.write' = ANY(scopes));
```

Then enable `QUOTUM_MCP_WRITES_ENABLED=true` with remote MCP enabled and reconnect clients with
fresh `quotum.billing.write` consent. Do not modify `platform_mcp_authorizations`, existing token
scopes or consent rows to grant access. Disabling the flag blocks new proposals and approvals while
retaining read access and result inspection. Stdio remains read-only. See [MCP](mcp.md).

## Upgrading a populated deployment to v0.20.0

v0.20.0 changes `migrations/003_metering_and_pricing.sql` for
[Apple promotion signatures](#apple-promotion-signatures) only. Move a populated v0.19.x deployment
with the data-only restore of [stored job provider identity](#stored-job-provider-identity):

1. **Check on v0.19.x.** v0.19.x never writes Apple promotion provider objects, so this query must
   return `0`; if it does not, rows were added by hand and need a bundle identity before the
   upgrade (see [Apple promotion signatures](#apple-promotion-signatures)):

   ```sql
   SELECT count(*) FROM promotion_provider_objects WHERE provider = 'apple';
   ```

2. **Stop the whole old service**: API, provider webhooks, merchant application and workers, as in
   step 1 of [stored job provider identity](#stored-job-provider-identity). Usage callers need no
   drain beyond pausing: v0.20.0 keeps v0.19.0's usage contract.
3. **Back up, migrate and restore**: take the `pg_dump --format=custom` backup, create an empty
   database, run `quotum migrate` from the new image, delete the seeded OAuth clients and restore
   the data without the migrations table, as in steps 1, 2 and 4 of
   [stored job provider identity](#stored-job-provider-identity). Skip its step 3: the v0.19.x data
   already carries every provider column.
4. **Start v0.20.0**, API and workers, and confirm `/ready`. Then deploy the console pinned to the
   release and pass `bun run check:deployment` from the UI repository. A v0.19.0 console keeps
   working against v0.20.0, but only the new one manages Apple offers.

A rollback restores the pre-upgrade backup with the v0.19.x image and loses what was written since.

## Upgrading a populated deployment to v0.19.0

v0.19.0 changes the metering baseline for five changes at once: the
[public SDK account and receipt cutover](#public-sdk-account-and-receipt-cutover), the
[canonical catalog intent](#canonical-catalog-intent), [calendar expiry](#calendar-expiry),
[unlimited usage items](#unlimited-usage-items) and the
[declared meter-limit scope](#declared-meter-limit-scope). They move together in one
stopped-service transition, in this order:

1. **Prepare on v0.18.x while it serves traffic.**
   - Run `quotum usage scopes report` until it exits `0`, resolving what it blocks as
     [prepare on the old release](#prepare-on-the-old-release) describes: catalog-migration targets
     priced through `basePrice`, and cancellations that take effect immediately.
   - Preview your catalog and fix what the price-spelling refusals report, so the first publish
     after the upgrade passes.
   - Ready the callers without deploying them: backends create each new account with
     `PUT /v1/billing-accounts/:billingAccountId` before its first usage, and call check and consume
     with `featureId` and `value`, without `filters` or `metadata`. Accounts that already exist,
     including those created implicitly by earlier usage, need no `PUT`.
2. **Pause callers and drain legacy usage operations** while the old API still serves. With usage
   callers stopped, look up every consume whose response was lost through
   `GET /v1/billing-accounts/:billingAccountId/usage/operations/consume/:operationId` (add
   `?entityId=` for an entity-scoped operation), and settle or release open reservations as callers
   require. A claim is written in the same transaction as its charge, so a request cut off by the
   stop leaves nothing to drain. After the upgrade a legacy consume's lookup, and a retry with its
   key, answer `409 OPERATION_RESULT_EXPIRED` and never charge again; holds survive the transition
   either way.
3. **Stop the whole old service**: API, provider webhooks, merchant application and workers, as in
   step 1 of [stored job provider identity](#stored-job-provider-identity).
4. **Record the scope snapshot** from the old database with the new image's `quotum`:
   `quotum usage scopes snapshot --out pre-scope.json`.
5. **Back up, migrate and restore**: take the `pg_dump --format=custom` backup, create an empty
   database, run `quotum migrate` from the new image, delete the seeded OAuth clients and restore
   the data without the migrations table, as in steps 1, 2 and 4 of
   [stored job provider identity](#stored-job-provider-identity). The calendar-expiry columns must
   then be empty (the queries are in [calendar expiry](#calendar-expiry)).
6. **Verify**: `quotum usage scopes verify --baseline pre-scope.json` must exit `0`. If it does not,
   start the old release on its untouched database and investigate.
7. **Start v0.19.0**, API and workers, and confirm `/ready`. Deploy the console re-pinned to the
   release and pass `bun run check:deployment` from the UI repository; an older console cannot read
   the canonical catalog or the compact usage results.
8. **Resume callers** on the new contract, and preview again any catalog previewed before the
   upgrade: such a preview answers `409 CATALOG_PREVIEW_MISMATCH`.

What operators and callers see afterwards:

- `GET /v1/admin/catalog` reads back the canonical intent and its `intentHash` changes once. A
  legacy plan priced through Stripe plan-level fields reads back as `providerPriced`: the plan-level
  amount is dropped and preview advises "Use `basePrice` when Quotum should model the price."
  Publish such plans with `basePrice` to keep an amount Quotum models.
- Check and consume answer `404 BILLING_ACCOUNT_NOT_FOUND` for an account that was never created.
  Balance, billing-summary and controls reads still answer it from the default plan.
- Meter limits count usage in their declared scope. Accounts already over an account cap are
  refused until a correction, a released hold or a higher limit leaves room.
- A rollback restores the pre-upgrade backup and loses what was written since.

## Public SDK account and receipt cutover

`migrations/003_metering_and_pricing.sql` now permits recovery version 2 and adds the nullable,
bounded `usage_events.receipt` snapshot. Update the Drizzle mirror and committed OpenAPI together.
Fresh disposable databases use the revised baseline. For a populated installation, follow the
backup/restore transition below, preserving existing claims and events; do not reset it or bypass
migration checksums. Historical events have no public receipt snapshot and are not synthesized from
current catalog or balance state.

Coordinate the API, bundled SDK, MCP, merchant adapter, UI contract and consuming backends:
checks and consumes now use `featureId`/`value`, reject filters and metadata, and return compact
results. Create accounts explicitly before usage and entity creation. New consumes store recovery
version 2 with the exact public outcome and receipt snapshot. Prior consumes retain their original
identity and billing effects; the new HTTP surface returns `OPERATION_RESULT_EXPIRED` for their
legacy outcome rather than returning another response type or charging again. Drain or reconcile
in-flight legacy operations before cutover; never mint replacement keys for uncertain charges.
Reserve/confirm/release/correction retain their current response contract for this preview.
No environment variable or API package version change is required.
## Apple promotion signatures

`migrations/003_metering_and_pricing.sql` now adds `promotion_apple_signature_attempts`, binding
each idempotent signing response to its project, customer and redemption. Apple provider objects
also require a bundle identity, have uniqueness by bundle/product/kind/offer identifier, and the
ledger enforces one redemption per Apple offer/subscription. The audit vocabulary adds mapping
retirement. No environment variable changes are required; the existing encrypted Apple connection
holds the signing key. Signature responses contain no private key.

Upgrade schema and API together before deploying the merchant UI pinned to the new API contract,
following [upgrading a populated deployment to v0.20.0](#upgrading-a-populated-deployment-to-v0200).
Recreate disposable development and test databases from the target baseline. The restore can only
fail on Apple rows that v0.19.x never writes: an Apple provider object without
`provider_account_id`, or two Apple redemptions of one provider object for one subscription. If the
check in that procedure finds Apple provider objects, relax the shape constraint in the freshly
migrated database before the restore, then give each object its app's bundle identifier and
restore the constraint:

```sql
-- Before the restore: keep the definition, then relax the constraint.
SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conname = 'promotion_provider_objects_shape_check';
ALTER TABLE promotion_provider_objects DROP CONSTRAINT promotion_provider_objects_shape_check;
-- After the restore: backfill, then restore the constraint with the definition kept above.
UPDATE promotion_provider_objects SET provider_account_id = '<bundle identifier>'
  WHERE provider = 'apple' AND provider_account_id IS NULL;
ALTER TABLE promotion_provider_objects
  ADD CONSTRAINT promotion_provider_objects_shape_check <definition> NOT VALID;
ALTER TABLE promotion_provider_objects VALIDATE CONSTRAINT promotion_provider_objects_shape_check;
```

Do not bypass checksum verification or reset a populated database. Rollback restores the
pre-upgrade backup with its matching image. The reservation maintenance worker releases abandoned
signatures after their 24-hour deadline; provider-confirmed late purchases remain recorded even if
a local limit is then exceeded.

## Stored job provider identity

The baselines add a required `provider` column to `subscription_changes` and
`usage_invoice_periods`, and a nullable `provider_account_id` to those tables and to
`auto_topup_jobs`, `checkout_requests`, `provider_customers` and `subscriptions`. A dump from an
earlier revision has no `provider` values, so a plain data restore loses every subscription change
and usage invoice period. The next recurring billing poll would then materialize the lost periods
again and invoice customers a second time. Move a populated deployment as follows:

1. Stop the whole old service, including its API, provider webhooks, merchant application and
   workers, and keep it stopped until the new version serves traffic. Anything the old version
   accepts after the dump is lost; while the service is down, providers retry undelivered webhooks.
   Then take a [backup](operations.md#backup) with `pg_dump --format=custom`.
2. Create an empty database and run `quotum migrate` from the target image. The merchant baseline
   seeds the built-in remote MCP OAuth clients `quotum-claude-code` and `quotum-cursor`. A
   dump taken from v0.13.1 or later already contains them, and the restore would stop on their
   duplicate `client_id`, so delete the seeded copies first; the restore brings them back with
   any clients registered since. Skip this for a dump from an earlier version, which has none.

   ```sql
   DELETE FROM platform_auth_oauth_clients;
   ```

3. Let the restore load rows that have no provider:

   ```sql
   ALTER TABLE subscription_changes ALTER COLUMN provider DROP NOT NULL;
   ALTER TABLE usage_invoice_periods ALTER COLUMN provider DROP NOT NULL;
   ```

4. Restore the data without the old migration history, which `migrate` already wrote. The schema
   has circular foreign keys, so the restore disables triggers and needs a superuser:

   ```sh
   pg_restore --list quotum-before-upgrade.dump \
     | grep -Ev ' TABLE DATA public migrations( |$)' > restore.list
   pg_restore --data-only --disable-triggers --exit-on-error --no-owner \
     --use-list restore.list --dbname "$POSTGRES_URI" quotum-before-upgrade.dump
   ```

5. Copy each job's provider from its subscription and restore the constraint. `SET NOT NULL` fails
   while any row still has no provider:

   ```sql
   UPDATE subscription_changes AS job SET provider = subscription.provider
   FROM subscriptions AS subscription
   WHERE subscription.project_id = job.project_id AND subscription.id = job.subscription_id
     AND job.provider IS NULL;
   UPDATE usage_invoice_periods AS job SET provider = subscription.provider
   FROM subscriptions AS subscription
   WHERE subscription.project_id = job.project_id AND subscription.id = job.subscription_id
     AND job.provider IS NULL;
   ALTER TABLE subscription_changes ALTER COLUMN provider SET NOT NULL;
   ALTER TABLE usage_invoice_periods ALTER COLUMN provider SET NOT NULL;
   ```

6. Compare the row counts of every table, at least `subscription_changes`,
   `usage_invoice_periods` and `usage_invoice_adjustments`, with the source database. Run
   `quotum migrate status`, then start the new version and confirm `/ready`.

Restored rows keep a null `provider_account_id`. Stripe events fill it on subscriptions and provider
customers once their connection reports an account identity; jobs copy it when they are created.

## Credential access level

The platform baseline adds `platform_project_api_credentials.access` (`full` or `read_only`,
default `full`), its check constraint, and a unique index that allows one live credential of each
kind per instance. The column is additive and has a default, so the move needs no manual SQL: follow
steps 1, 2, 4 and 6 above. The data-only restore lists its columns, so every existing credential
takes `access = 'full'` and keeps authenticating. Afterwards confirm

```sql
SELECT access, count(*) FROM platform_project_api_credentials GROUP BY 1;
```

returns only `full`. The restore fails on the new unique index if an instance holds more than one
unrevoked credential; no release creates that state, so revoke the stale rows in the source database
and dump again. An older image does not recognize `sqrk_` or `pqrk_` tokens and rejects them, so a
rollback fails closed.

## Trial ending notices

The billing core baseline adds `subscriptions.trial_ending_notified_at` with a check that it is set
only on a subscription with a trial, the partial index `idx_billing_subscriptions_trial_ending_due`,
and a projection payload check that keeps a `trial` fact apart from `purchase` and `reversal`. Every
addition admits existing rows, so the move needs no manual SQL: follow steps 1, 2, 4 and 6 above.
Restored subscriptions carry no marker, so the first reconciliation pass sends one ending notice for
each App Store or Play trial then within three days of its end. Stripe trials are announced only by
`customer.subscription.trial_will_end` events received after the upgrade. Right after the restore,

```sql
SELECT count(*) FROM subscriptions WHERE trial_ending_notified_at IS NOT NULL;
```

returns 0.

## Plan grants

The metering baseline adds the `plan_grants` table, a nullable `balance_allocations.plan_grant_id`
with its foreign key, and a reward provenance check that also accepts a plan grant. The billing core
baseline adds a nullable `entitlements.source_plan_grant_id`, whose foreign key the metering baseline
adds. Every existing reward already carries its promotion redemption, so the move needs no manual
SQL: follow steps 1, 2, 4 and 6 above. Afterwards

```sql
SELECT count(*) FROM plan_grants;
SELECT count(*) FROM balance_allocations WHERE source_kind = 'reward' AND promotion_redemption_id IS NULL;
```

both return 0. An older image cannot read the new baselines, so a rollback restores the
pre-upgrade backup and loses grants created since.

## Operator grants

The metering baseline adds the `operator_grants`, `administrative_debits` and
`administrative_debit_allocations` tables, and a nullable `balance_allocations.operator_grant_id`
with its foreign key. The check `balance_allocations_operator_provenance_check` requires every
`operator` allocation to link its grant. Before this version only the test entrypoints, the merchant
test seed and the load lane wrote `operator` allocations, so count them in the old database before
dumping:

```sql
SELECT count(*) FROM balance_allocations WHERE source_kind = 'operator';
```

With none, follow steps 1, 2, 4 and 6 of [stored job provider identity](#stored-job-provider-identity).
Otherwise give each such allocation a grant, which the restore cannot do on its own because it
still enforces checks:

1. Follow steps 1 and 2 there.
2. Let the restore load unlinked `operator` allocations:

   ```sql
   ALTER TABLE balance_allocations DROP CONSTRAINT balance_allocations_operator_provenance_check;
   ```

3. Restore the data as in step 4 there.
4. Record one grant per allocation, link it and restore the check. Adding the check fails while any
   `operator` allocation is left unlinked:

   ```sql
   INSERT INTO operator_grants (
     project_id, customer_id, actor, reason, idempotency_key, request_hash, created_at, updated_at
   )
   SELECT project_id, customer_id, 'upgrade-backfill',
     'Operator allocation recorded before operator grants', 'backfill:allocation:' || id,
     encode(sha256(convert_to('backfill:allocation:' || id, 'UTF8')), 'hex'), created_at, created_at
   FROM balance_allocations WHERE source_kind = 'operator';
   UPDATE balance_allocations AS allocation SET operator_grant_id = backfill.id
   FROM operator_grants AS backfill
   WHERE allocation.source_kind = 'operator'
     AND backfill.project_id = allocation.project_id
     AND backfill.customer_id = allocation.customer_id
     AND backfill.idempotency_key = 'backfill:allocation:' || allocation.id;
   ALTER TABLE balance_allocations ADD CONSTRAINT balance_allocations_operator_provenance_check
     CHECK ((source_kind = 'operator') = (operator_grant_id IS NOT NULL));
   ```

5. Finish with step 6 there.

The backfilled grants keep their allocations' original source keys and can be revoked like any
other. An older image cannot read the new baselines, so a rollback restores the pre-upgrade backup
and loses grants and debits made since.

## Default plan

The metering baseline adds the `catalog_default_plans` table, one row per published revision that
marks a default plan, and the `default_plan_reconciliations` job table. It widens `plan_grants`:
- `origin` accepts `default`;
- `ends_at`, `duration_unit`, `duration_count`, `idempotency_key` and `request_hash` become nullable,
  with the new check `plan_grants_term_check` requiring them to be null exactly on a default-plan
  grant;
- a new `superseded_by_plan_grant_id` column references the trial that replaced a default-plan
  grant, with a deferred foreign key and its index;
- `plan_grants_bounds_check` and `plan_grants_state_check` allow a grant without an end;
- `idx_billing_plan_grants_due` covers only grants with an end;
- `next_period_at` and its index `idx_billing_plan_grants_next_period` are dropped, because a
  write now records a window's allowance and no worker tracks the next one.

`default_plan_reconciliations` records the accounts a pass left behind in `customers_skipped`,
`last_skipped_customer_id` and `last_skip_error`, and `idx_billing_balance_allocations_plan_grant`
adds `feature_id` and `period_start_at` for the lookup a write makes before it spends.

Existing trial rows satisfy every new check and no earlier revision has a marker. Follow steps 1, 2,
4 and 6 of [stored job provider identity](#stored-job-provider-identity), but give the restore the
column that a dump from v0.15.0 or later still carries. Before step 4 run:

```sql
ALTER TABLE plan_grants ADD COLUMN next_period_at TIMESTAMPTZ;
```

After the restore, drop it again:

```sql
ALTER TABLE plan_grants DROP COLUMN next_period_at;
```

Allowances the old worker created for current windows stay in use. Afterwards
`SELECT count(*) FROM catalog_default_plans;` and
`SELECT count(*) FROM plan_grants WHERE origin = 'default';` both return 0 until a catalog marks a
default plan. Stored catalog intents without the marker keep their intent hash, so a preview taken
before the upgrade still publishes.

## Plan-change carry-over

The metering baseline adds `carry_over` to the `balance_allocations.source_kind` check, and adds the
following:
- a nullable `carry_over_origin_allocation_id`, with its foreign key, the unique index
  `idx_billing_balance_allocations_carry_over_origin` and the check
  `balance_allocations_carry_over_shape_check`;
- `subscription_changes.carry_over`, a JSONB column defaulting to `{}`;
- the `carried_usages` table.

Existing rows satisfy every check, so follow steps 1, 2, 4 and 6 of
[stored job provider identity](#stored-job-provider-identity).

The same release ends a subscription's outgoing plan allowances when it moves to another plan
version. Earlier versions kept them spendable alongside the new version's grant, so after the
upgrade a plan change leaves only the new allowance.

The upgrade does not end allowances that a plan change before it left live: they stay spendable
until their own expiry, and one from an item with no reset and no expiry never ends. After the
restore, list them:

```sql
SELECT allocation.project_id, allocation.customer_id, allocation.id, allocation.quantity,
  allocation.consumed_quantity, allocation.expires_at
FROM balance_allocations allocation
JOIN plan_items item
  ON item.project_id = allocation.project_id AND item.id = allocation.plan_item_id
JOIN subscriptions subscription
  ON subscription.project_id = allocation.project_id
  AND subscription.id = allocation.subscription_id
WHERE allocation.source_kind = 'subscription'
  AND allocation.reversed_at IS NULL
  AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
  AND item.plan_version_id <> subscription.plan_version_id;
```

Keeping them honours what customers were already given. To end them the way a plan change now
does, without rollover, run the following before starting the new version. A reservation held on
one still confirms, and projection receivers see the lower balance with the account's next
projection.

```sql
UPDATE balance_allocations AS allocation
SET expires_at = now(),
  rollover_processed_at = COALESCE(allocation.rollover_processed_at, now()),
  updated_at = now()
FROM plan_items AS item, subscriptions AS subscription
WHERE item.project_id = allocation.project_id AND item.id = allocation.plan_item_id
  AND subscription.project_id = allocation.project_id
  AND subscription.id = allocation.subscription_id
  AND allocation.source_kind = 'subscription'
  AND allocation.reversed_at IS NULL
  AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
  AND item.plan_version_id <> subscription.plan_version_id;
```

## Reset cadence

The metering baseline widens `plan_items.reset_interval` to the cadence units (`hour`, `day`,
`week`, `month`, `quarter`, `semi_annual`, `year`) and adds `reset_interval_count` (default 1) with
the check `plan_items_reset_interval_count_check`. It replaces `rollover_expiry_months` with
`rollover_expiry_interval` and `rollover_expiry_interval_count`, and the rollover expiry mode
`months` with `after`. It widens `control_policies.interval` and `usage_alerts.interval` the same
way, keeping `lifetime`, and adds `interval_count` (default 1) to both with the checks
`control_policies_interval_count_check` and `usage_alerts_interval_count_check`; month and year
control windows keep their calendar bounds, so existing `control_windows` rows stay current.
Billing intervals widen the same way without `hour`: `plan_versions` and `price_components` gain
`billing_interval_count` (default 1, checks `plan_versions_billing_interval_count_check` and
`price_components_billing_interval_count_check`), and the billing core baseline adds
`store_products.billing_period_count` (default 1) and constrains `billing_period` to `one_time` or a
billing unit (`store_products_billing_period_check`, `store_products_billing_period_count_check`).
Before dumping, confirm that no store product uses another period:

```sql
SELECT DISTINCT billing_period FROM store_products;
```

Rewrite any other spelling, such as `monthly`, to `month` in the old database first, or the restore
fails on the new check. Existing reset, control and billing intervals need no other change; only
rollover rows are rewritten:

1. Follow steps 1 and 2 of [stored job provider identity](#stored-job-provider-identity).
2. Let the restore load the old rollover column:

   ```sql
   ALTER TABLE plan_items ADD COLUMN rollover_expiry_months INTEGER,
     DROP CONSTRAINT plan_items_rollover_expiry_check;
   ```

3. Restore the data as in step 4 there.
4. Rewrite month-based expiries and restore the constraint. Adding the constraint fails while any
   row is left in the old form:

   ```sql
   UPDATE plan_items SET rollover_expiry_mode = 'after', rollover_expiry_interval = 'month',
     rollover_expiry_interval_count = rollover_expiry_months
   WHERE rollover_expiry_mode = 'months';
   ALTER TABLE plan_items DROP COLUMN rollover_expiry_months,
     ADD CONSTRAINT plan_items_rollover_expiry_check CHECK (
       (
         rollover_enabled = false AND rollover_max_quantity IS NULL
         AND rollover_expiry_mode = 'none' AND rollover_expiry_interval IS NULL
         AND rollover_expiry_interval_count = 1
       )
       OR (
         rollover_enabled = true AND rollover_expiry_mode IN ('forever', 'after')
         AND (
           (rollover_expiry_mode = 'forever' AND rollover_expiry_interval IS NULL
             AND rollover_expiry_interval_count = 1)
           OR (rollover_expiry_mode = 'after'
             AND rollover_expiry_interval IN
               ('hour', 'day', 'week', 'month', 'quarter', 'semi_annual', 'year')
             AND rollover_expiry_interval_count BETWEEN 1 AND 1000)
         )
       )
     );
   ```

5. Finish with step 6 there.

Meter limits, spend and usage limits and usage alerts can now reset hourly. Every window an account
uses is a `usage_windows` or `control_windows` row of about 450 bytes with its indexes, and closed
windows are kept, so an hourly limit adds up to 24 rows a day for each account that uses it; plan
storage for that before offering hourly limits widely.

Published catalogs keep their meaning: a stored `{ "mode": "months" }` expiry reads back as `after`
with a month interval, and every reset gains `resetIntervalCount: 1`. That changes the normalized
intent, so a catalog preview taken before the upgrade fails to publish with
`CATALOG_PREVIEW_MISMATCH` and must be previewed again, and the first `quotum catalog diff` of an
unchanged catalog reports `changed: true` with an empty impact.

## Declared meter-limit scope

The baselines add `usage_windows.scope`, part of the window's unique index, and
`reservations.filter_key`. A meter limit's declared `allocationScope` becomes authoritative
([declared meter-limit scope](metering.md#meter-limits)): an `account` cap counts every entity's and
filter value's usage in one window, and an `entity` cap gives each entity the whole limit, where
before each entity and filter value had its own window with the whole limit. No usage is moved and
no reservation is cancelled: windows written before keep their usage, subscription and plan item,
and count where the declared scope places them from the first request after the upgrade. Accounts
whose usage across entities and filters already exceeds an account cap are refused further usage
until a correction, a released hold or a higher limit leaves room.

The release also refuses account and entity caps an account could hold together on one feature,
and entity caps that allow postpaid overage. Prepare on the old release, then move with a
verified, stopped-service transition.

### Prepare on the old release

Run the read-only report, which ships before this release:

```sh
quotum usage scopes report              # every project instance, as text
quotum usage scopes report --project acme --json
```

It reads one consistent snapshot, writes nothing and takes no locks beyond plain reads. For each
meter-limited feature it lists the scope, overage policy and cap that every published plan version,
and every version subscriptions or plan grants are still pinned to, declares. For each account with
an open window it sums usage and active holds the way the declared scope will, and lists the groups
that change and the hard caps already exceeded.

It exits `2` while any of these **blocking** items remain:

- an account whose live subscriptions cap one feature with different scopes; migrate one of them,
  or cancel it immediately: a cancellation at the period end keeps the subscription live, and the
  item blocking, until that period ends;
- an entity-scoped limit with postpaid overage on a version a subscription or grant still holds;
  migrate those subscriptions to a blocked or account-scoped version;
- an open window that no meter limit applies to any more, for example after a subscription lapsed.

**Warnings** do not block: a base and add-on pair, or two add-ons, that cap one feature with
different scopes although no account holds both, and postpaid entity limits nobody holds yet. The
next publication refuses them.

For a feature that should stay per entity, publish a version declaring
`allocationScope: "entity"` (hard caps only), then move the subscriptions pinned to the old version
with a [catalog migration](catalog.md#catalog-migrations): publishing alone moves nobody. Price the
migration's target version through `basePrice`: on the old release a target priced only through the
legacy plan-level fields fails the migration job with "Target plan does not have a complete
published Stripe recurring-price mapping". Run the
report again until the effective scope of every affected account is the one you intend and nothing
blocks.

### Move with a verified transition

1. Run the report on the old release: it must exit `0`.
2. Stop the whole old service, as in step 1 of
   [stored job provider identity](#stored-job-provider-identity).
3. Record the baseline the verification compares against, from the old database before it is
   dumped. Run it with the new image's `quotum` and the old database's `POSTGRES_URI`; it reads only
   columns both schemas have, and never overwrites a file:

   ```sh
   quotum usage scopes snapshot --out pre-scope.json
   ```

4. Take the [backup](operations.md#backup), then create the new database, run `quotum migrate` from
   the new image and restore the data, as in steps 1 to 4 of
   [stored job provider identity](#stored-job-provider-identity), with any steps the other
   transitions in this release add.
5. Verify the new database. **Start the service only when this exits `0`**:

   ```sh
   quotum usage scopes verify --baseline pre-scope.json
   ```

   It checks, against the snapshot:
   - **usage totals**: every window row and its usage are unchanged, and so is the usage summed per
     subscription, plan item and window, open and closed alike, which is what invoices bill;
   - **active holds**: the same active reservations, on the same windows and quantities, each on a
     window inside the scope set its account now counts;
   - **correction routing**: every consume or confirm in an open window names an open window of its
     account, feature and bounds inside the scope set it counts in, so a later correction frees
     capacity where the limit counts (the query reads only the open windows' partitions);
   - **invoice attribution**: pending and processing invoice periods are unchanged, and closed usage
     not invoiced yet would invoice the same quantities;
   - **no capacity gain**: every scope set counts at least each of its windows' usage;
   - **blockers**: no account holds mixed scopes, and no open window with usage or holds is left
     without a meter limit.

   It also lists the scope sets already over their cap, by project instance, billing account,
   feature key and external entity, which are refused until room is left and do not fail the
   verification. `--json` prints the whole result. A failure exits `2`: do not
   start the service; start the old release on its untouched database instead and investigate.
   Because nothing was moved, restoring the dump from step 4 into the old schema also reads as
   before.
6. Start the new version and confirm `/ready`.

## Canonical catalog intent

No migration. The control plane now stores and hashes the [canonical intent](catalog.md#canonical-intent)
and reads a catalog stored in the legacy spelling as its canonical form, so published catalogs keep
their meaning:

- `GET /v1/admin/catalog`, `client.catalog.status` and the MCP `get_catalog` tool return the
  canonical spelling: `basePrice` and `providerPriced` instead of the plan-level price fields, and
  item `reset`, `expiry` and `overage` instead of `resetInterval`, `expiresAfterSeconds` and
  `overagePolicy`. Deploy a console that reads the canonical spelling with this release; an older
  console cannot read the published catalog.
- The reported `intentHash` changes once, to the hash of the canonical intent. Each revision keeps
  the hash recorded when it was published. `quotum catalog diff` of an unchanged catalog file
  reports `changed: false`, in either spelling, and republishing an unchanged catalog creates no
  plan version.
- A catalog preview taken before the upgrade stored the legacy spelling, so it fails to publish with
  `CATALOG_PREVIEW_MISMATCH` and must be previewed again. Previews last 30 minutes.
- A plan's products are now both its `basePrice` bindings and its plan-level (provider-priced)
  bindings. A plan that sent both spellings used to lose its Stripe base price product's plan
  binding; its next published version binds it, so a Stripe subscription to that product finds the
  plan. Versions published before keep their bindings until a new version replaces them.
- New intents are checked a little differently. A legacy plan whose plan-level bindings name
  products without a `basePrice` needs a `billingInterval`, and a legacy access item may not carry an
  expiry or a reset; both used to be accepted. A default plan with only a plan-level `currency` or
  `baseAmountMinor`, and no price or binding, is now unpriced and accepted, with those fields
  dropped.

## Calendar expiry

The metering baseline adds `expiry_interval` (a cadence unit) and `expiry_interval_count`
(default 1) to `plan_items` and `topup_options`, with the checks `plan_items_expiry_interval_check`,
`plan_items_expiry_check`, `topup_options_expiry_interval_check` and `topup_options_expiry_check`:
the count runs from 1 to 1,000, needs an interval, and an item or option expires after seconds or
on a cadence, never both. Every addition admits existing rows, so the move needs no manual SQL:
follow steps 1, 2, 4 and 6 of [stored job provider identity](#stored-job-provider-identity). The
data-only restore lists its columns, so every restored item and option takes no calendar expiry and
keeps its `expires_after_seconds`. Afterwards confirm

```sql
SELECT count(*) FROM plan_items WHERE expiry_interval IS NOT NULL;
SELECT count(*) FROM topup_options WHERE expiry_interval IS NOT NULL;
```

both return 0. Published catalogs keep their meaning and their canonical hashes: an exact
`expiresAfterSeconds` still reads back as `{ "mode": "after_seconds" }`, and nothing moves to a
calendar cadence until a catalog asks for one. An older image cannot read the new baseline, so a
rollback restores the pre-upgrade backup and loses catalogs published since.

## Unlimited usage items

The metering baseline widens `plan_items_item_kind_check` to admit `unlimited_usage`, and
`plan_items_quantity_check` to let it, like `access`, carry no quantity and no reset. Both checks
only widen, so every existing row passes them and the move needs no manual SQL: follow steps 1, 2,
4 and 6 of [stored job provider identity](#stored-job-provider-identity). No stored catalog holds an
unlimited item, so balances and decisions are unchanged until a catalog publishes one. An older
image cannot read the new baseline, so a rollback restores the pre-upgrade backup and loses catalogs
published since.
