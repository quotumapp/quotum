# Operations: backup, restore, upgrade, rollback

- Document kind: Current behavior

- Sources: [runtime](../src/runtime.ts), [migration runner](../src/migrate.ts), [HTTP app](../src/app.ts), [workers](../src/workers).

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
| [003_metering_and_pricing.sql](../migrations/003_metering_and_pricing.sql) | Catalog, metering, operation recovery, pricing, controls, commercial actions, payment setup, promotions, plan grants, operator grants, administrative debits, default plans and plan-change carry-over |
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

[Upgrade transitions](upgrade-transitions.md) gives the data-preserving procedure for each baseline
change that needs one.

Remote MCP extends `004_merchant.sql` with the OAuth provider tables, JWKS storage, immutable
authorizations, public desktop-client registrations and a transient proof-binding column. Two
platform status triggers permanently revoke grants and refresh replay responses on principal or
membership suspension. Deploy the matching schema before an MCP-enabled API; the transport remains
off unless explicitly enabled. See [remote MCP deployment](deployment.md#remote-mcp). These changes
do not create project credentials or alter the stdio credential policy.

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
transaction, so the replaced key is rejected from the next request. The database clock dates both
the issue and the revocation, so application clock skew cannot fail a rotation. Write the
replacement to every integration's secret store and redeploy those backends. `platform:bootstrap`
issues only the declared credential kinds an instance has never held, whether the instance is new
or already exists, so it does not rotate. To add an environment or a project later, extend the
manifest, review `--check`, and run `--apply` with a new `--credentials-out` path.

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

Local messages, context and ordinary errors use the same privacy rules as Sentry: recognized
credentials and personal data are masked, sensitive keys are removed, and URL identifiers become
`:id` with query strings and fragments removed. Request/job correlation, project keys, worker names,
status and safe error codes remain available. Values are bounded to five levels, 50 keys/items and
1,024 characters per string. Scrubbing is best effort for arbitrary free text; never put customer
data in a diagnostic message. Unreadable input becomes `[Unserializable]` locally or is dropped by
Sentry, and serialization hooks on context objects are not invoked.

Events use Pino's numeric `level`, epoch-millisecond `time`, `pid`, `hostname`, and `msg` fields.
Additional fields remain nested under `context`; errors use `err.type`, `err.message`, and
`err.stack` when present. Error objects do not contribute arbitrary additional properties.
BigInt context values are decimal strings and circular references use `[Circular]`.

Database errors, including wrapped Drizzle and PostgreSQL failures, use `err.type: "DatabaseError"`
and `err.message: "Database operation failed"`. They include `err.sqlState` when available and
`err.constraint` only for a bounded PostgreSQL identifier. SQL, parameters, driver messages,
detail/hint and raw database stacks are omitted. Nested causes are inspected without changing the
original error used by retries. Structured context also drops raw database payload keys such as
`query`, `params`, `parameters`, `detail` and `hint`.

Collectors must tolerate removed sensitive context fields and truncated strings. Use request/job
correlation and `err.sqlState` for investigations; for example, `40P01` identifies a deadlock and
`23505` a unique-constraint violation. Sentry retains structured source locations for database
errors, with source snippets and local variables removed. This change needs no schema migration or
environment configuration and takes effect on deployment.

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
| Subscription reconciliation (provider reads, subscription and plan grant expiry, default-plan passes, trial-ending notices) | `BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS` |
| Metering maintenance (reservation expiry, reset-window subscription allocations, rollovers, rollup close, retention sweeps) | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Recurring billing | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Automatic top-ups | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Promotion maintenance (expired reservation release, Stripe coupons and hosted promotion codes) | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Stripe App event processing, only when the Apps OAuth integration is configured | `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS` |
| [Usage partition upkeep](#usage-partitions), unless `BILLING_USAGE_PARTITION_UPKEEP=false` | Fixed, every 15 minutes |

Automatic top-up and recurring billing renew every outstanding claim in their current batch,
including jobs waiting behind a provider call. The heartbeat runs every 60 seconds against the
five-minute reclaim window. Each provider dispatch and completion also checks ownership; a lost
lease skips that work, and a database error during the check leaves the claim for recovery. A
provider call already in flight cannot be recalled, so completion markers remain fenced and Stripe
retries keep their existing job-scoped idempotency keys. Heartbeats prevent live-job reclamation;
they do not extend Stripe's idempotency retention or guarantee recovery after a prolonged outage.
Provider event replay and subscription reconciliation also renew their claims. Projection delivery
claims up to 25 jobs per poll from a candidate set bounded by the batch size and delivers five
concurrently with bounded HTTP timeouts.
Usage-driven projections are one job per billing account built at delivery, so the backlog is
bounded by active accounts. Tune intervals and attempt limits with the `BILLING_*` variables listed
in [deployment.md](deployment.md#optional-variables).

Allocations that reset more often than their plan bills (monthly on an annual plan, weekly on a
monthly one) use the existing metering maintenance cadence and allocation ledger; no additional
worker or environment setting is required. The run result logs `grantedSubscriptionAllocations` and
`transitionedSubscriptionAllocations`. On the first synchronization or maintenance pass after
upgrade, an existing allocation for the whole provider period is adopted into the current reset
window. Its ID, source key, consumption, reservations and reversals are retained, its expiry is
capped at the next reset boundary without extending an earlier expiry, and no extra credits are
issued for the current window. The next window receives a fresh grant. Missed windows are not
compensated retroactively. Replace old webhook handlers and workers together so the old
whole-period grant code does not run alongside per-window materialization. Maintenance grants at
most one batch per poll, so an allocation that resets daily needs the poll to keep up with every
subscription within the day.

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

### Default-plan passes

Every account without a paid base plan holds a default-plan grant: one grant row and one
entitlement row per key. Allowance rows exist only for the windows the account wrote in, so an
idle free account costs no rows and sends no projection when its allowance resets. A publish that
changes the default plan queues one pass over the project's customers. The subscription
reconciliation worker runs it after grant expiry: it scans 1,000 customers per slice, changes up to
its batch size of them, and spends at most ten slices per poll. Reads and writes do not wait for
it (see [Default plan](grants.md#default-plan)); it keeps grants, entitlement rows and projections
current for accounts that neither read nor write. Each changed account gets a stored projection
job. Plan the delivery backlog for large free tiers: a first default plan enqueues one job per
covered account.

The pass changes each account under its own savepoint. An account whose change fails is rolled
back and left behind: the pass counts it in `customers_skipped`, keeps the last one in
`last_skipped_customer_id` and `last_skip_error`, and the worker run reports `defaultPlanSkipped`
with a `partial` outcome. The account's next write applies the change instead. A slice that fails
as a whole is counted in `defaultPlanFailedSlices` and retried with backoff (`attempts`,
`last_error`), while the run moves on to other projects' passes. To find both:

```sql
SELECT project_id, status, customers_checked, grants_changed, customers_skipped,
  last_skipped_customer_id, last_skip_error, attempts, last_error
FROM default_plan_reconciliations
WHERE customers_skipped > 0 OR attempts > 0;
```

### Provider write recovery foundation

`provider_operations` stores one immutable intent per project, billing account, provider and
idempotency key. It records the original provider account and connection version, a request hash
and body, and a resource key. The repository refuses changed input and concurrent unresolved work
on the same provider-account resource, including work in `requires_review`.

A dispatch lease changes `prepared` to `in_flight` before network I/O; the database permits at most
one dispatch. An expired lease never permits another dispatch. Network errors, malformed replies
and local completion failures leave the operation unresolved. Reconciliation uses the original
account identity, can observe an effect or request review, and never repeats the write. Lease tokens
and database-clock deadlines fence stale local completion. Credential rotation may preserve the
original receipt; changing the provider account cannot.

Paddle sandbox customer and checkout creation use this ledger. The `provider_operation_recovery`
worker polls every ten seconds, selecting at most ten expired in-flight or reconciling operations.
Each observation claims a fresh 60-second lease, renewed every 20 seconds, and uses the recorded
connection version. Transient failures back off exponentially from ten seconds, capped at one hour;
after ten recovery attempts they require review. Ambiguous, absent or mismatched remote effects
require review immediately. Unavailable projects are deferred so they cannot starve eligible work.
`prepared` operations are dispatched only by a matching caller retry; automatic recovery never writes.

`GET /v1/billing-accounts/:billingAccountId/provider-operations/:operationId` returns a safe receipt,
including to read-only credentials. An operator can request another observation with
`POST /v1/admin/billing-accounts/:billingAccountId/provider-operations/:operationId/reconcile`, using
project authentication, `X-Billing-Operator-Key` and `X-Billing-Actor`. The request appends actor,
time and prior status to `review_requests` before recovery. Terminal receipts stay terminal; this
endpoint never redispatches, forces success/failure or releases an unresolved resource. Keep the
original credentials and provider evidence available; do not clear rows to make a replacement run.
Common Paddle preview/execute uses the same ledger. Retry the original token/key while the receipt
is unresolved, including after preview expiry once execution was claimed. Recovery resolves the
recorded connection version; an unavailable version fails closed. Completed commercial receipts
replay without a provider call, and concurrent completions preserve the first result.
A succeeded direct or common checkout receipt replays (`duplicate: true`) from its durable operation
with no provider read, even after the Paddle price was archived, the price endpoint became
unavailable or the store mapping was retired; only a new key is checked against the current catalog.
Paddle checkout also owns a durable `paddle_checkout_reservations` row. One open row per
project/billing account covers common and direct checkout, including the time after transaction
creation succeeds but before payment. Competing callers receive `409 PADDLE_CHECKOUT_PENDING`;
the conflict details identify the available original preview/operation. Keep the original key.
A `failed` checkout receipt stays terminal (`409 PROVIDER_OPERATION_FAILED`), while its reservation
closes so a corrected request with a new key can proceed. A retry repairs an interrupted local
reservation cleanup only when the retained operation proves definitive rejection.
Customer creation is attempted once per checkout key: its `customer.create` operation is keyed by
the account and that key, and its terminal receipt stays immutable. Before reserving a checkout, the
same key with a rejected customer returns `409 PROVIDER_OPERATION_FAILED`, and a changed email under
that key returns `409 IDEMPOTENCY_CONFLICT`. A definitive rejection (a provider 4xx answer,
including a `429`) created no Paddle customer, so a new checkout key, with the same or a corrected
email, creates it once. The failed receipt carries the reason in `details.errorCode`: a rate limit
is `PADDLE_RATE_LIMITED` (retry with a new key after the cooldown), and `customer_already_exists`
means Paddle already holds a customer for that email. Quotum does not adopt a customer it did not
create, so every new key asks Paddle again and gets the same answer until the email is changed or
the existing Paddle customer is removed or archived. A customer write that is still
unresolved (`prepared`, `in_flight`, `reconciling` or `requires_review`) blocks every other key with
`409 PROVIDER_OPERATION_PENDING` until it is reconciled; previews check the same condition before
reserving anything. Operations created before this change are keyed by the account alone: an
unresolved one with the same email is resumed by the next attempt, and a failed one no longer
blocks new keys.
While the process-wide Paddle rate-limit cooldown is active (set by any 429, including another
project's, because all projects share one egress IP), a checkout is refused before it reserves or
prepares anything, and so is a price read: `503 BILLING_PROVIDER_UNAVAILABLE` with
`details.retryAfterSeconds`. No receipt records that refusal, so the same Idempotency-Key is retried
unchanged once the interval has passed. A price read that Paddle cannot answer (`5xx`, timeout) is
reported the same way instead of as `500 INTERNAL_ERROR`. A cooldown that begins in the few
milliseconds between that check and the write itself still refuses the write locally, and that
refusal is a failed receipt like any other definitive rejection: retry with a new key.
If local preparation fails after reservation, cleanup closes only a reservation with no bound
operation, recording `rejected`; binding is required before dispatch. Bound or ambiguous writes
keep their reservation. A locally rejected owner cannot dispatch again; start a fresh preview or
checkout key after correcting the local failure.

A signed `transaction.canceled` event is persisted and processed by the existing store-event replay
worker. Before closing the matching reservation, it fetches the transaction with a matching provider-account
connection and verifies canceled status, account/customer identity and operation correlation.
Non-API transactions (including renewals) and transactions without valid Quotum checkout
correlation are ignored. Correlated but conflicting customer or operation evidence still fails
with `PADDLE_FULFILLMENT_MISMATCH` and cannot release a reservation.
Fulfillment closes the reservation in the transaction that grants access. A cancellation of an
older checkout cannot close a newer reservation. These transitions never rewrite a completed
commercial receipt. There is no new polling worker or public cancellation command.

Fulfillment, renewal, cancellation and reconciliation follow the recorded checkout intent, not
current sale state. A store mapping or product retired after the checkout was created still
activates the paid subscription, still extends it when the provider reports a paid renewal and
still revokes access when the provider reports cancellation, whether the signal arrives as a signed
event or through reconciliation; only an event whose price, product or customer differs from the
recorded intent fails with `PADDLE_FULFILLMENT_MISMATCH`.

Reservations have no time-based expiry. An unavailable connection, ambiguous write or missing
cancellation delivery keeps the account blocked; restore the recorded connection and replay the
provider notification through the normal signed ingress/replay pipeline. Do not delete receipts
or reservations to permit another checkout. `PADDLE_CHECKOUT_CLOSED` means an already-closed owner
cannot dispatch again; use its retained receipt when one exists. A restored nonfailed legacy
checkout without a reservation also blocks new keys until its history is reconstructed under the
[upgrade procedure](upgrade-transitions.md#upgrading-a-populated-deployment-to-v0220).

Existing Stripe workflows retain their own recovery and do not produce these receipts.

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
