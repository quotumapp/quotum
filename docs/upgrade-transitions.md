# Upgrade transitions

- Document kind: Current behavior
- Sources: [migrations](../migrations), [migration runner](../src/migrate.ts).

Before 1.0 the baseline migrations evolve in place under the
[schema and upgrade policy](operations.md#schema-and-upgrade-policy), so a populated deployment
moves to a changed baseline by restoring its data into a freshly migrated database. The
[stored job provider identity](#stored-job-provider-identity) section gives that procedure in full;
the later sections name the steps they reuse and add what their own change needs. A release's pull requests name the baselines it changes under
`Upgrade notes`.

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

## Preparing for declared meter-limit scope

Accepted target, not yet enforced: a later release makes a meter limit's declared
`allocationScope` authoritative. An `account` cap will sum every entity's and filter value's usage
in a window, and an `entity` cap will sum each entity's filters, where today each entity and filter
value gets its own window with the whole limit. That release also refuses account and entity caps
an account could hold together on one feature, and entity caps that allow postpaid overage. It
moves no usage and cancels no reservation, and its stopped-service transition will be documented
here when it ships.

Prepare on the current release with the read-only report:

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

- an account whose live subscriptions cap one feature with different scopes; migrate or cancel one
  of them;
- an entity-scoped limit with postpaid overage on a version a subscription or grant still holds;
  migrate those subscriptions to a blocked or account-scoped version;
- an open window that no meter limit applies to any more, for example after a subscription lapsed.

**Warnings** do not block: a base and add-on pair, or two add-ons, that cap one feature with
different scopes although no account holds both, and postpaid entity limits nobody holds yet. The
next publication refuses them. Publishing a new version is not enough on its own, because
subscriptions stay pinned to their version until a
[catalog migration](catalog.md#catalog-migrations) moves them.
Accounts over a hard cap are informational: once the scope is enforced they are denied while
usage plus active holds leave no capacity, and a correction, a released hold or a higher limit
restores it.

