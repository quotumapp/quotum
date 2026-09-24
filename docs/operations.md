# Operations: backup, restore, upgrade, rollback

- Document kind: Current behavior
- Sources: [runtime](../src/runtime.ts), [migration runner](../src/migrate.ts), [HTTP app](../src/app.ts), [CI](../.github/workflows/ci.yml), [image publishing](../.github/workflows/docker-publish.yml).

## Backup

- Back up Postgres with `pg_dump` or your provider's snapshots. All billing state, migration history,
  and encrypted connections live there.
- Back up `QUOTUM_SECRETS_KEY_BASE64` separately in your secret manager. Encrypted connections in a
  database backup are unreadable without it, and the key must never be stored with the backup.
- Project credentials and the merchant service-principal token are one-way hashed; they cannot be
  recovered from a backup. Reissue them instead.

```sh
pg_dump --format=custom --no-owner "$POSTGRES_URI" > quotum-$(date +%F).dump
```

## Restore

Restore into an empty database, then verify the migration history matches the release you are about
to run:

```sh
pg_restore --no-owner --dbname "$POSTGRES_URI" quotum-2026-09-09.dump
quotum migrate status
```

Every applied migration must have a matching local file and checksum. A missing applied file or a
checksum mismatch fails both `quotum migrate status` and `quotum migrate`; use the release matching
the backup. From a source checkout, `bun run migrate:status` and `bun run migrate` are equivalent.

## Schema and upgrade policy

The current schema is initialized from these ordered baseline files:

<!-- migration-inventory:start -->
| File | Owns |
| --- | --- |
| [001_platform.sql](../migrations/001_platform.sql) | Organizations, projects, instances, credentials and customer connections |
| [002_billing_core.sql](../migrations/002_billing_core.sql) | Billing accounts, purchases, subscriptions, entitlements and provider/projection jobs |
| [003_metering_and_pricing.sql](../migrations/003_metering_and_pricing.sql) | Catalog, metering, operation recovery, pricing, controls, commercial actions, payment setup and promotions |
| [004_merchant.sql](../migrations/004_merchant.sql) | Merchant identity, authentication, sessions, membership, audit and connection OAuth state |
<!-- migration-inventory:end -->

Before 1.0 these files evolve in place. Incremental migrations start at 1.0 under the current
[contribution policy](../CONTRIBUTING.md#migrations). The runner checks applied filenames and
checksums before applying any pending SQL; it does not convert databases from retired migration
chains or preserve their records through recreation. Do not bypass the check by editing migration
history.

For disposable development/test databases, recreate from the target revision when the baseline
changes. For a populated deployment, retain a restorable backup and its matching service revision;
an incompatible schema change needs an explicit data-preserving transition before upgrading.
Never reset populated production data as a routine upgrade.

Remote MCP extends `004_merchant.sql` with the OAuth provider tables, JWKS storage, immutable
authorizations, public desktop-client registrations and a transient proof-binding column. Two
platform status triggers permanently revoke grants and refresh replay responses on principal or
membership suspension. Deploy the matching schema before an MCP-enabled API; the transport remains
off unless explicitly enabled. See [remote MCP deployment](deployment.md#remote-mcp). These changes
do not create project credentials or alter the stdio credential policy.

### Stored job provider identity

The baselines add a required `provider` column to `subscription_changes` and
`usage_invoice_periods`, and a nullable `provider_account_id` to those tables and to
`auto_topup_jobs`, `checkout_requests`, `provider_customers` and `subscriptions`. A dump from an
earlier revision has no `provider` values, so a plain data restore loses every subscription change
and usage invoice period. The next recurring billing poll would then materialize the lost periods
again and invoice customers a second time. Move a populated deployment as follows:

1. Stop the whole old service, including its API, provider webhooks, merchant application and
   workers, and keep it stopped until the new version serves traffic. Anything the old version
   accepts after the dump is lost; while the service is down, providers retry undelivered webhooks.
   Then take a [backup](#backup) with `pg_dump --format=custom`.
2. Create an empty database and run `quotum migrate` from the target image.
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

### Credential access level

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

## Upgrade

1. Read the target version's [GitHub Release](https://github.com/quotumapp/quotum/releases) and
   the descriptions of the pull requests it lists, starting with **Breaking changes**, and the
   [schema policy](#schema-and-upgrade-policy). Releases up to 0.10.1 are described in the
   [changelog archived at v0.10.1](https://github.com/quotumapp/quotum/blob/v0.10.1/CHANGELOG.md).
   Establish database compatibility before rollout.
2. Take a backup.
3. If the upgrade notes say so, stop usage writers and workers on the old version.
4. Run `quotum migrate status` from the target image. Stop if integrity verification fails;
   follow the schema policy before proceeding. On a compatible or freshly recreated disposable
   database, run `quotum migrate`. The runner takes an advisory lock, applies pending files in
   order, and runs each transactionally unless the file contains `CREATE INDEX CONCURRENTLY` or
   opts out with `-- migrate: no-transaction`.
5. Start the new version and confirm `/ready`.

## Rollback

Rolling back the binary is safe only when the target version still understands the current schema.
Stop the service before rolling back a migration that changes worker claim columns, and keep usage
traffic stopped until a compatible build is running.

Do not edit `purchases`, `subscriptions`, `entitlements`, or `commercial_action_previews` by hand,
and do not advance contract, migration, top-up, or subscription-change job state manually. Use the
replay, reconciliation, and retry admin routes described in the [API guide](api.md#admin-operations)
so idempotency is preserved.

## Project credentials

Sandbox and production instances receive separate project credentials: `sqpk_<secret>` for
sandbox, `pqpk_<secret>` for production (see [authentication](deployment.md#authentication)). The
plaintext is disclosed once: at sandbox provisioning, production activation, rotation, or into a
`platform:bootstrap --credentials-out` file. Replaying the same request returns no credential. A
lost response cannot be recovered; rotate instead.

Rotate through merchant management: `POST /api/platform/provisioning/{id}/rotate` for onboarding
sandbox credentials, or `POST /api/platform/environments/credentials/rotate` for either environment.
Production rotation requires a fresh step-up grant. Without the merchant application, run
`quotum credentials rotate <instance> --access full --credentials-out <new-file>` with `--actor`.
It writes the new key in the platform bootstrap's file format and never prints it. If the file
cannot be written, nothing is rotated. Rotation revokes the previous credential in the same
transaction, so the replaced key is rejected from the next request. Write the replacement to every
integration's secret store and redeploy those backends. `platform:bootstrap` issues only the
declared credential kinds an instance has never held, whether the instance is new or already
exists, so it does not rotate. To add an environment or a project later, extend the manifest,
review `--check`, and run `--apply` with a new `--credentials-out` path.

### Read-only credentials

An instance can also hold one [read-only credential](api.md#read-only-credentials) (`sqrk_<secret>`
or `pqrk_<secret>`) for inspection tools such as the [MCP server](mcp.md). It is issued on request,
never automatically:

- Merchant management: `POST /api/platform/environments/credentials/rotate` with
  `"access": "read_only"` issues the key when the instance has none and replaces it otherwise. It
  needs the same capability as a full rotation and, in production, a step-up grant for the action
  `credentials.rotate_read_only`. Grants and idempotency keys are bound to the kind: a confirmation
  given for a read-only key cannot replace the backend's key, and reusing an idempotency key for the
  other kind is an `IDEMPOTENCY_CONFLICT`.
- `platform:bootstrap`: set `"issueReadOnlyCredential": true` on an active sandbox or production
  instance. The token is written to a separate `readOnlyCredentials` array of the
  `--credentials-out` file, so the `credentials` array keeps one entry per instance. Like full keys,
  bootstrap issues a read-only key once and never rotates it.

The two kinds rotate independently: replacing one never revokes the other.

- `POST /api/platform/environments/credentials/status` reports, for each kind, whether the
  environment holds a live key and when it was issued. It never returns key material. It answers for
  active and inactive environments; a suspended or deactivated one is `404 CONTEXT_UNAVAILABLE`.
- `POST /api/platform/environments/credentials/revoke` with `"access": "read_only"` withdraws the
  read-only key without minting a replacement, and the key is rejected from the next request. It
  needs the rotation capability, an active environment and, in production, a step-up grant for the
  action `credentials.revoke_read_only`. It answers `revoked: false` when no key was live; replaying
  that idempotency key later does not revoke a key issued since. The full key cannot be withdrawn,
  only rotated: a backend without a key is an outage.

The audit trail records `credential.issued`, `credential.rotated` and `credential.revoked` with the
`access`.

### Replacing retired `qpk_v1` credentials

Earlier releases issued `qpk_v1.<uuid>.<secret>` credentials. They no longer authenticate and are
rejected like any unknown credential. Stored hashes cannot be converted into new keys because the
plaintext is never retained, so every integration needs a replacement:

1. Take a backup. Establish schema compatibility under the
   [schema policy](#schema-and-upgrade-policy); the platform baseline adds a unique index on
   `platform_project_api_credentials.secret_verifier`. Recreate disposable databases, including
   operator bootstrap fixtures, which then issue new-format credentials.
2. Deploy the new runtime. Integrations using `qpk_v1` credentials receive `401 UNAUTHORIZED` from
   this point, and only the new runtime can issue replacements, so schedule the cutover with each
   integration owner.
3. Rotate every active sandbox and production credential through merchant management and confirm
   each replacement starts with the prefix of its environment.
4. Update each integration's secret store, redeploy it, and confirm an authenticated request
   succeeds. Remove the retired credential from secret stores.

## Health, readiness, and metrics

- `GET /livez` is a static liveness check; `/health` is a public alias.
- `GET /ready` checks database reachability and the required platform schema. Customer integration
  readiness is separate and never gates the process.
- `GET /metrics` is a public non-customer-labelled Prometheus registry in the current API; apply
  ingress restrictions if this endpoint should be private in a deployment.
- `GET /v1/admin/metrics` returns the registry through the project-authenticated admin boundary
  and requires `X-Billing-Operator-Key`. Health routes are public.
- Error reporting is optional via `SENTRY_DSN`, covers staff and merchant 5xx plus worker
  failures, payloads scrubbed; see [Sentry (optional)](deployment.md#sentry-optional).

Both metrics endpoints return Prometheus text (`text/plain; version=0.0.4`) containing process
metrics by default, even before billing activity. Existing `billing_*` counters and metering
histograms appear as their operations run. Runtime metrics have no project or customer labels;
`bun_version_info` has only a `version` label.

| Metric | Type and meaning |
| --- | --- |
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total`, `process_cpu_seconds_total` | Counters: cumulative process CPU time in seconds, including time before exporter creation. |
| `process_resident_memory_bytes` | Gauge: resident process memory in bytes. |
| `nodejs_heap_size_total_bytes`, `nodejs_heap_size_used_bytes` | Gauges: Bun's JavaScript heap size and usage in bytes. |
| `nodejs_external_memory_bytes` | Gauge: external memory reported by Bun in bytes. |
| `process_start_time_seconds` | Gauge: process start time as Unix epoch seconds; stable across scrapes. |
| `process_uptime_seconds` | Gauge: elapsed process uptime in seconds. |
| `nodejs_eventloop_lag_seconds` | Gauge: delay in seconds of one immediate callback scheduled during the scrape. |
| `bun_version_info{version="…"}` | Gauge: always `1`, labelled with the actual Bun version. |

The `nodejs_*` names retain compatibility with common process dashboards; the memory readings
describe Bun's JavaScriptCore runtime. Node/V8 GC, heap-space, active handle/request/resource,
and event-loop utilization collectors are excluded because Bun's compatibility APIs cannot report
them faithfully. Event-loop lag is one scrape-time sample, not an interval maximum or percentile.
Collection runs only during scrapes, with no persistent sampling timer. Concurrent scrapes share
an in-flight collection. Each app/runtime owns its registry and billing counters; process readings
cover the entire process, including HTTP handling and workers.
Billing instrumentation retains its synchronous interface. The HTTP layer combines its output
with the asynchronous runtime exporter for both metrics endpoints, including when billing metrics
are supplied through dependency injection.

For an existing Prometheus deployment, scrape each Quotum replica directly, replacing the example
target with its reachable address:

```yaml
scrape_configs:
  - job_name: quotum
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ["quotum:3000"]
```

Inspect the response with `curl http://127.0.0.1:3000/metrics`. Prometheus supplies the `job` and
`instance` target labels. No additional Quotum environment variables, ports, migrations, or exporter
processes are required. The runtime continues to return 503 before `start()` and after `stop()`.

## Diagnostic logs and command output

Service diagnostics use newline-delimited Pino JSON on stdout, including warnings and errors.
Operator scripts and migration diagnostics write the same format to stderr. Writes are synchronous
so final fatal-error and shutdown events reach the destination before process exit. Logging failures
must not change billing results. `BILLING_LOG_LEVEL` defaults to `info` and controls local output;
`silent` disables it without disabling Sentry forwarding. Sentry retains its own `SENTRY_LOG_LEVEL`,
expected-error policy, and context sanitization.

Events use Pino's numeric `level`, epoch-millisecond `time`, `pid`, `hostname`, and `msg` fields.
Additional fields remain nested under `context`; errors use `err.type`, `err.message`, and
`err.stack` when present. Error objects do not contribute arbitrary additional properties.
BigInt context values are decimal strings and circular references use `[Circular]`.

When upgrading from console logging, update log collectors alongside the service: string `level`
becomes numeric, `timestamp` becomes `time`, `message` becomes `msg`, and `error.name` becomes
`err.type`. Collect service warnings/errors from stdout and script diagnostics from stderr.
No database migration is required, and the new log-level setting is optional.

Command results retain their plain output contracts: catalog and bootstrap JSON, migration-status
lines, secret-rotation counts, release labels and summaries, help, and report tables. The
service-principal command still prints its one-time credential as command output; do not collect it
as a diagnostic log. The reference projection receiver logs delivery summaries without printing its
configured secret.

## Workers

One process runs the HTTP API and all workers. Each polls on the interval shown:

| Worker | Interval variable |
| --- | --- |
| Projection delivery | `BILLING_WORKER_POLL_INTERVAL_MS` |
| Provider event replay | `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS` |
| Subscription reconciliation | `BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS` |
| Metering maintenance (reservation expiry, rollovers, rollup close, retention sweeps) | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Recurring billing | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Automatic top-ups | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Promotion maintenance (expired reservation release, Stripe coupons and hosted promotion codes) | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Stripe App event processing, only when the Apps OAuth integration is configured | `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS` |
| [Usage partition upkeep](#usage-partitions), unless `BILLING_USAGE_PARTITION_UPKEEP=false` | Fixed, every 15 minutes |

Replicas coordinate through leased jobs with heartbeats; projection delivery claims up to 25 jobs
per poll from a candidate set bounded by the batch size and delivers five concurrently.
Usage-driven projections are one job per billing account built at delivery, so the backlog is
bounded by active accounts. Tune intervals and attempt limits with the `BILLING_*` variables listed
in [deployment.md](deployment.md#optional-variables).

Raw usage is partitioned monthly. Technical retention uses `metering_settings.raw_usage_retention_days`
(default 400); durable monthly rollups outlive deleted raw rows. This default is not a legal
retention guarantee or an implemented versioned privacy policy.

### Usage partitions

Raw usage (`usage_events`) is partitioned by UTC month of `recorded_at`. The baseline migration
creates partitions from the month before it ran to 24 months after, plus `usage_events_default`
for anything outside them. The usage partition upkeep job keeps partitions at least 12 months
ahead: it adds one month per short transaction, continuing from the last partition's upper bound,
and never touches existing partitions or rows. A run that waits more than a second for the table
lock gives up and retries on the next run, and runs skip while another replica or the migration
runner holds their advisory lock. Each run counts its outcome in
`billing_usage_partition_upkeep_runs_total{result}`:

| `result` | Meaning |
| --- | --- |
| `current`, `created`, `locked` | Nothing to do: coverage reaches the horizon, partitions were added, or another process is running the upkeep or migrations. |
| `lock_timeout` | The table lock was busy; the next run retries. Alert only if it persists. |
| `blocked` | `usage_events_default` holds rows. Adding a partition would scan it under a table lock, so upkeep stops and logs a warning. |
| `forbidden` | The runtime role does not own `usage_events`. |
| `failed` | Any other error, logged with its cause. |

Alert on `blocked`, `forbidden` and `failed`; while upkeep is stopped, usage that arrives after the
last partition lands in `usage_events_default`. The job runs at least a year before partitions run
out, so there is time to act.

`quotum partitions status` lists the monthly partitions and how far ahead they reach. It exits `2`
when they end less than 12 months ahead (or `--months <n>`, at most 120) or when
`usage_events_default` holds rows. `quotum partitions ensure` runs the same upkeep on demand until
the partitions reach that horizon and lists what it created. It exits `1` and names the reason when
it stops early with `locked`, `lock_timeout`, `blocked` or `forbidden`. Both read `POSTGRES_URI`.

- `forbidden`: run the service with the role that owns the schema, as the documented single
  `POSTGRES_URI` does, or set `BILLING_USAGE_PARTITION_UPKEEP=false` and have the owner run
  `quotum partitions ensure` with its own `POSTGRES_URI`, for example from a monthly job.
- `blocked`: rows usually reach the default partition through a data-only restore of usage older
  than the baseline's first partition. Raw-usage retention deletes them after
  `raw_usage_retention_days`, and upkeep resumes by itself once the default partition is empty.
  Do not detach or drop `usage_events_default`: other tables reference usage rows through foreign
  keys, so moving rows needs a reviewed maintenance plan.

Automatic top-up failures require resolving the payment/configuration cause before a protected
circuit reset. Use replay/retry routes for durable work; do not manually advance job state.

### Hosted payment setup recovery

Hosted payment-method setups ride the provider event replay worker. The webhook route only records
the setup's completion or expiry as a pending store event, so the work always happens under a
worker lease, outside the request and outside any transaction. Each setup also gets one internal
task of its own, a `quotum.payment_setup.reconcile` store event, committed atomically with the
setup reservation before any provider request. It:

- re-issues a creation whose response was lost, with the setup's frozen provider idempotency key —
  creation is attempted only within the provider's 24-hour idempotency retention window and
  with more than one hour remaining before the frozen expiry. Outside either bound it marks
  the setup `needs_attention` instead of sending an expired or potentially duplicated request;
- applies a completion whose webhook never arrived;
- confirms expiry with the provider before the account's single setup slot is released.

A task that is only waiting reports a **deferred** outcome: the job is rescheduled with a new
`next_attempt_at` and its `attempts` count is left alone, so an open hosted session can never
exhaust the retry budget a real failure needs. Provider failures still consume attempts; once a
setup's task has spent its budget, the setup is marked `needs_attention` with the reason, keeps the
account's slot, and is retried every six hours. This transition uses the smaller of five failures
and the worker's configured attempt limit. Unresolved ordinary polling runs every 30 minutes,
including after the local expiry; local time alone cannot prove provider expiry.

A setup in `creating`, `applying_default` or `needs_attention` holds the account's slot on purpose:
an uncertain setup stays visible instead of being replaced. Do not clear `payment_setup_sessions`
rows by hand. A setup whose creation response and webhook were both lost may have no provider
session identifier; after its safe retry window it requires operator investigation in Stripe.
The reconciler cannot automatically prove completion or expiry in that case.

Customer creation now scopes its Stripe idempotency key to the project. Before rolling this
change out, reconcile any provider customer creations whose response or local linkage was lost
under the previous unscoped key; otherwise a retry can create a duplicate customer. Existing
linked customers are reused without creating another provider customer.

## Load lane

`bun run test:load` boots the real service and drives metering over HTTP. The default scenarios use
a closed-loop client; `users` uses a fixed arrival rate. It creates a disposable Postgres container
only when neither `--postgres-uri` nor `POSTGRES_URI` is set. An environment value, including one
loaded by Bun, selects an existing database; `--postgres-uri` overrides it. **The selected database
is migrated, bootstrapped and its billing tables are reset. Use only a disposable database.** A
reused target keeps its earlier bootstrap and issues no fresh credential; add `--recreate-schema`
to drop and recreate its `public` schema first. `--docker` explicitly selects a fresh disposable
container, overriding an environment URI; when combined with `--postgres-uri`, the last selector wins.

The lane publishes a metered catalog and grants balances to one hot account and, by default,
1,000 spread accounts. Scenarios are `hot` (one account, one feature), `spread` (round-robin),
`reserve` (reserve then confirm), `check`, and `workers-off` (hot and spread with worker polling
intervals extended to one hour). The last scenario keeps polling idle during short runs; it does
not permanently disable workers. Keep `workers-off` last in a custom scenario list because later
scenarios do not restore the normal polling intervals.

### One merchant with many active users

Use `users` to test one merchant project with independent billing accounts, each sending exactly
one scheduled `consume` per second. User arrivals are evenly staggered across the second and do
not wait for earlier responses. `--users` specifies successive active-user counts; enough accounts
are seeded automatically. `--concurrency` does not control this scenario.

```sh
BUN_CONFIG_MAX_HTTP_REQUESTS=4096 bun run test:load --docker \
  --scenarios users --users 100,1000,2000,5000,10000 \
  --duration 30 --warmup 2 --max-p99-ms 50 --out /tmp/quotum-users.json
```

This tests 100 through 10,000 requested consumes/second. Bun otherwise queues fetches above its
[default 256 simultaneous-request limit](https://bun.sh/docs/runtime/environment-variables); set
`BUN_CONFIG_MAX_HTTP_REQUESTS` above the harness's `--max-in-flight` limit (default 2000).
The harness counts arrivals it cannot send at that limit
as capacity drops. Arrivals more than 100 ms late are counted as generator drops, without a catch-up
burst. Either means the requested workload was not delivered. Fetch attempts time out after
`--request-timeout-ms` (default 5000); timeout does not imply that the server rolled back.

For `users`, RPS means successful authorizations completed **during the scheduled arrival window**.
Responses completed while draining are reported separately through the total accepted count and
request drain time; they do not inflate that RPS. JSON also reports scheduled/sent/accepted counts,
in-flight requests at the end of the window, dispatch lag, and latency measured from scheduled
arrival as well as actual dispatch. Every successful response is reconciled to a durable idempotency
claim and a matching usage event for the correct account, quantity and wallet charge. Committed
operations with lost responses can exceed the successful-response count. This check is a snapshot
after the drain, not proof that timed-out server work has stopped.

The warmup issues checks rather than consumes. Seed-time projection jobs are cleared before the
first measurement. Each level records projection backlog before load, after request drain, and
after a bounded `--drain-seconds` wait (default 10). The API process is restarted and remaining
fixture projection jobs cleared between levels so overload does not carry queued requests into the
next level. These are independent load levels, not a continuous ramp or a durability/failover test. Metering rate
limits are raised for the fixture; production admission limits are not measured.

Missing arrivals, non-allowed responses, reconciliation failures and leftover projection backlog
fail the lane, as do supplied `--min-rps`/`--max-p99-ms` thresholds. Results and gate failures are
written to `--out` **before** a failing exit, so overload evidence is retained. Database connection
strings are redacted in reports. A short local run validates behavior under load; use longer runs
and a separate generator to establish deployment capacity and steady-state worker freshness.

### Metrics and other options

Results include client latency percentiles, scenario iterations and ledger calls per second,
Postgres transactions, WAL bytes, dead tuples, sampled lock waits, projection jobs created,
delivered and left in backlog, and sampled service/container CPU. A successful reserve iteration
makes two HTTP calls; its client latency covers reserve plus confirm, while server percentiles
use the confirm operation's histogram. Server percentiles are histogram bucket upper bounds.
Statement counts and database time per request are aggregate ratios from `pg_stat_statements`,
not isolated attribution to each HTTP request. These values can be unavailable when the extension
or its reset is unavailable. CPU values can also be unavailable; an existing database has no
container CPU sample.

`--profile [consume|check|reserve]` skips the scenarios, runs fifty sequential requests against the hot
account after a warmup, and lists every statement they execute with its calls per request, rows
and mean execution time from `pg_stat_statements`. `--pg-config setting=value` (repeatable) passes
Postgres settings to the container, for example `synchronous_commit=off` to isolate commit latency.

Options: `--duration` and `--warmup` in seconds, `--concurrency 1,8,32,64`, `--accounts`,
`--scenarios`, `--out file.json`, `--pg-config setting=value` (container only, repeatable), and
`--postgres-uri` to select a disposable existing database instead of a container.

Results from a laptop container are shapes, not capacity: the client, the service and Postgres
share one machine and the container runs Postgres defaults. Quote only figures measured on a sized
instance, and record them together with the source revision they were measured against.

## Release verification

Run the API quality, OpenAPI, unit, PostgreSQL integration and process E2E gates from the selected
source revision. Record the image digest and migration checksums; test the chosen UI/API revisions
together before rollout. A health probe alone does not verify onboarding, step-up, catalog, provider
events or signed projections. Verify only the providers enabled for the environment; native-only
projects do not require an unused Stripe connection.

## Release and support policy

Quotum is pre-1.0. Each release must be tagged `vX.Y.Z` and published as a container image and a
GitHub Release with the same version using the checklist below. Its pull requests carry the
migrations and upgrade order. Only the latest release line receives fixes, published as a new patch on
`main`. Security issues are handled privately; see [SECURITY.md](../SECURITY.md).

## Publish a container release

The [Publish image workflow](../.github/workflows/docker-publish.yml) publishes
`ghcr.io/quotumapp/quotum` for `linux/amd64` and `linux/arm64`:

| GitHub push | Container tags | GitHub Release |
| --- | --- | --- |
| Commit on `main` | `main` (rolling development image) | None; the run summary lists changes since the last release |
| Stable release tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, and `latest` when it is the highest stable version | Published, marked latest when it is the highest stable version |
| Prerelease tag `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` only | Published as a prerelease |

The Git tag is the release version; no release branch, version-bump commit or release PR is
required. `package.json` and the committed OpenAPI snapshot keep `0.0.0-dev`. Release builds
use the tag version for `BUILD_VERSION`, OCI metadata and the attached OpenAPI `info.version`.
Branch builds use `0.0.0-dev.<commit>`; each `main` run lists changes since the last stable release.
Both publishing and ordinary
[CI](../.github/workflows/ci.yml) call the same [standalone validation](../.github/workflows/validate.yml).
The publish job requires successful validation of its exact source commit. Validation checks out
only this public repository, requires no private siblings or corporate credentials, and has read-only
repository permissions; registry write access is limited to the publishing job, and release write
access to the release job that runs after it.

The release job creates the GitHub Release only after the image is pushed, so a published release
proves the image exists. Its notes are GitHub's generated list of the pull requests merged since
the previous release tag (the previous stable tag, or the closest lower tag for a prerelease),
grouped by label through [`.github/release.yml`](../.github/release.yml), with a compare link.
Details and upgrade notes stay in the pull request descriptions. Labels come from pull request
titles; see [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests). The release attaches
`openapi.json` (copied from `contracts/v1/` with only `info.version` stamped), the unchanged
`errors.json`, and an `image.json` that records the image
digest, commit and publishing run. Releases are immutable once published: assets and the tag cannot
change, so correct a bad release with a new patch release. Release notes can still be edited.

1. Review the pull requests merged since the last release; the latest `main` publishing run
   summary lists them. Choose the version: before 1.0, a minor release for breaking changes or
   features and a patch release for fixes only. Select the existing `main` commit to release and
   complete [release verification](#release-verification) for that revision. Do not bump
   `package.json` or create a release PR.
2. From a clean checkout of that `main` revision, verify the GitHub remote and CI for the merged
   commit. These examples use `github` for `quotumapp/quotum`; substitute the actual GitHub remote
   name if different. In the multi-repository workspace, a GitLab remote does not trigger GitHub
   image publishing. The commands use Git, `jq`, GitHub CLI and Docker Buildx. Keep the release
   variables in the same shell through the remaining steps.

   ```sh
   git remote -v
   git fetch github main --tags
   release_commit=$(git rev-parse github/main)
   gh run list --repo quotumapp/quotum --workflow ci.yml --commit "$release_commit"
   ```

   Wait for CI to succeed for this exact commit before continuing. A successful `main` image
   build alone is not the release verification gate.
3. Set the chosen version, create its annotated tag on the verified commit, and
   push that one tag to GitHub:

   ```sh
   release_version=X.Y.Z # Replace with the chosen version, without the v prefix
   git tag -a "v$release_version" "$release_commit" -m "Release v$release_version"
   git push github "refs/tags/v$release_version"
   ```

   Push release tags individually: GitHub does not emit tag push events when more than three
   tags are pushed together. See [GitHub's push event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).
   A tag ruleset limits creating, moving and deleting `v*` tags to repository administrators. Do
   not move an existing release tag to another commit.
4. Find the `Publish image` run for the new `vX.Y.Z` tag and wait for both the `Build and push`
   and `GitHub Release` jobs to succeed. The same commit can also have a `main` publishing run, so
   check the run's ref:

   ```sh
   gh run list --repo quotumapp/quotum --workflow docker-publish.yml --commit "$release_commit"
   ```

   If the release job fails after the image is pushed, re-run that job. It replaces an unpublished
   draft and leaves an already published release unchanged.
5. Confirm the image tags in [GHCR package versions](https://github.com/quotumapp/quotum/pkgs/container/quotum/versions)
   and check the release against the registry:

   ```sh
   gh release view "v$release_version" --repo quotumapp/quotum
   gh release download "v$release_version" --repo quotumapp/quotum -p image.json -O - | jq -r .digest
   gh release verify "v$release_version" --repo quotumapp/quotum
   docker buildx imagetools inspect "ghcr.io/quotumapp/quotum:$release_version"
   ```

   Verify both target platforms, that the digest in the release's `image.json` matches the
   inspected top-level digest, and that `X.Y` and, for the highest stable version, `latest` resolve
   to the same digest at publication time. Use the recorded digest to pin deployments; `main`, `X.Y`
   and `latest` move as subsequent builds are published. A release is published only after the
   GitHub Release and the versioned image are verified. Follow [Upgrade](#upgrade) separately to
   deploy it.
