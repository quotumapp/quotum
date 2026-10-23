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
| [002_billing_core.sql](../migrations/002_billing_core.sql) | Billing accounts, purchases, subscriptions, entitlements, provider/projection jobs and outbound webhook endpoints, events and deliveries |
| [003_metering_and_pricing.sql](../migrations/003_metering_and_pricing.sql) | Catalog, metering, operation recovery, pricing, controls, commercial actions, payment setup, promotions, plan grants, operator grants, administrative debits, default plans, plan-change carry-over and Stripe binding adoption receipts |
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
   [schema policy](#schema-and-upgrade-policy). A release whose notes open with
   `Upgrade requires backup and restore` changed a baseline: plan the stopped-service
   [transition](upgrade-transitions.md) before anything else. Releases up to 0.10.1 are described in the
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
plaintext is disclosed once when requested during onboarding, through environment credential
issuance or rotation, or into a `platform:bootstrap --credentials-out` file. Both environments are
active from creation, independently of whether either key has been issued. Replaying the same
request returns no credential. A lost response cannot be recovered; rotate instead.

Rotate through merchant management: `POST /api/platform/provisioning/{id}/rotate` for onboarding
sandbox credentials, or `POST /api/platform/environments/credentials/rotate` for either environment.
Production rotation requires a fresh step-up grant. Without the merchant application, run
`quotum credentials rotate <instance> --access full --credentials-out <new-file>` with `--actor`;
an organization whose members manage it also needs `--member-override-reason <why>`. Rotating, or
revoking a read-only key, requires an active environment (`ENVIRONMENT_INACTIVE` otherwise).
It writes the new key in the platform bootstrap's file format and never prints it. If the file
cannot be written, nothing is rotated. Rotation revokes the previous credential in the same
transaction, so the replaced key is rejected from the next request. The database clock dates both
the issue and the revocation, so application clock skew cannot fail a rotation. Write the
replacement to every integration's secret store and redeploy those backends. `platform:bootstrap`
issues only the declared credential kinds an instance has never held, whether the instance is new
or already exists, so it does not rotate. To add an environment or a project later, extend the
manifest, review `--check`, and run `--apply` with a new `--credentials-out` path.

### Add a project

An organization that finished onboarding adds a project with `POST /api/platform/projects`, which
takes `{ organizationSlug, name, key }` and an `Idempotency-Key` header. The caller needs the
`project.create` capability (Owner, Admin or Developer). The route answers with the same provisioning
operation as onboarding, so `GET /api/platform/provisioning/{id}`, `/retry`, `/credential` and
`/rotate` drive the rest. Two refusals are `409`: `PROJECT_KEY_UNAVAILABLE` when the organization
already has a project with that key, and `PROJECT_LIMIT_REACHED` when it already holds its
`QUOTUM_PROJECT_LIMIT` projects (default 5, a positive integer configured on the API process).
Every logical project counts once, including suspended projects; its two environments share that
slot. Both start active. The same cap applies during onboarding, and organization locking makes
concurrent creation respect it. Lowering the setting preserves existing projects but prevents
another until the organization is below the cap. Operator `platform:bootstrap` remains exempt.
The legacy database columns `project_limit` and `production_limit` are retained for schema
compatibility and ignored. There is no separate production quota.

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

### Stop an instance

The full key cannot be withdrawn, only rotated, so there is no "revoke" for a backend's access. To
stop an environment's traffic, from fastest and most reversible:

- **Suspend it.** `quotum environments suspend <instance> --reason <why> --actor <you>` answers
  the environment's project keys with `401 UNAUTHORIZED` at once, while provider webhooks,
  reconciliation and the workers carry on. `quotum environments resume <instance>` ends it. While
  suspended, `quotum credentials`, `quotum connections` and `quotum environments readiness` answer
  `CONTEXT_UNAVAILABLE`, so rotate a leaked key before suspending, or resume first. See
  [suspend and resume](deployment.md#suspend-and-resume-an-environment).
- **Replace the key and discard the new one.** `quotum credentials rotate <instance> --access full
  --credentials-out <new-file> --actor <you>` rejects the old key from the next request. Delete the
  file and nobody holds the replacement, but a valid key still exists, so suspension is the cleaner
  stop.
- **End one integration.** `quotum connections disable <instance> <kind> --expected-revision <n>`
  turns off one provider or projection connection. It does not stop `/v1` requests.

None of these deletes data or revokes the read-only key; withdraw that separately with
`quotum credentials revoke <instance> --access read_only`.

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
histograms appear as their operations run. Runtime metrics have no project, customer or account
labels, because `/metrics` is unauthenticated: billing series are labelled only by `worker`,
`provider`, `operation`, `result`, `code`, `status`, `classification` and `route_group`, a list the
code keeps closed (`BillingMetricLabelName` in `src/observability/metrics.ts`). A series therefore
aggregates every project on the replica; the logs, not the metrics, name the project behind a
failed projection delivery. `bun_version_info` has only a `version` label.

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

The `billing_*` counters are described with the feature that raises them; for example,
[outbound webhook delivery](webhooks.md#retries) counts each attempt in
`billing_event_delivery_total{result,code}`.
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

One process runs the HTTP API and all workers, sharing the configured database pool. Each polls
on the interval shown; unset per-worker overrides preserve the shared fallbacks documented in
[worker tuning](deployment.md#worker-tuning). Every default remains unchanged:

| Worker | Interval variable |
| --- | --- |
| Projection delivery | `BILLING_PROJECTION_SYNC_POLL_INTERVAL_MS` (falls back to `BILLING_WORKER_POLL_INTERVAL_MS`) |
| [Outbound webhook delivery](webhooks.md) (fan-out, signed deliveries, event retention) | `BILLING_EVENT_DELIVERY_POLL_INTERVAL_MS` (falls back to `BILLING_WORKER_POLL_INTERVAL_MS`) |
| Provider event replay | `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS` |
| Subscription reconciliation (provider reads, subscription and plan grant expiry, default-plan passes, trial-ending notices) | `BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS` |
| Metering maintenance (reservation expiry, reset-window subscription allocations, rollovers, rollup close, retention sweeps) | `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS` |
| Recurring billing | `BILLING_RECURRING_BILLING_POLL_INTERVAL_MS` (falls back to `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS`) |
| Automatic top-ups | `BILLING_AUTO_TOPUP_POLL_INTERVAL_MS` (falls back to `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS`) |
| Promotion maintenance (expired reservation release, Stripe coupons and hosted promotion codes) | `BILLING_PROMOTION_MAINTENANCE_POLL_INTERVAL_MS` (falls back to `BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS`) |
| [Provider operation recovery](#provider-write-recovery-foundation) | `BILLING_PROVIDER_OPERATION_RECOVERY_POLL_INTERVAL_MS` (10000) |
| [Customer erasure](#customer-erasure) | `BILLING_CUSTOMER_ERASURE_POLL_INTERVAL_MS` (falls back to `BILLING_WORKER_POLL_INTERVAL_MS`) |
| Stripe App event processing, only when the Apps OAuth integration is configured | `BILLING_STRIPE_APP_EVENTS_POLL_INTERVAL_MS` (falls back to `BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS`) |
| [Usage partition upkeep](#usage-partitions), unless `BILLING_USAGE_PARTITION_UPKEEP=false` | `BILLING_USAGE_PARTITION_UPKEEP_POLL_INTERVAL_MS` (900000) |
| [Platform retention](#merchant-platform-retention) | `QUOTUM_PLATFORM_RETENTION_POLL_INTERVAL_MS` (900000) |

Automatic top-up, recurring billing and promotion maintenance renew every outstanding claim in their current batch,
including jobs waiting behind a provider call. The heartbeat runs every 60 seconds against the
five-minute reclaim window. Each provider dispatch and completion also checks ownership; a lost
lease skips that work, and a database error during the check leaves the claim for recovery. A
provider call already in flight cannot be recalled, so completion markers remain fenced and Stripe
retries keep their existing job-scoped idempotency keys. Heartbeats prevent live-job reclamation;
they do not extend Stripe's idempotency retention or guarantee recovery after a prolonged outage.
Promotion runs count skipped claims as `leaseSkipped` and emit the worker metric result
`lease_skipped`, including ownership-check failures; neither counts as a provider failure.
Provider event replay and subscription reconciliation also renew their claims. Projection delivery
defaults to claiming up to 25 jobs per poll from a candidate set bounded by the batch size and
delivering five concurrently with bounded HTTP timeouts. Batches, existing delivery concurrency,
scan sizes and per-run budgets have optional overrides in [worker tuning](deployment.md#worker-tuning).
Retry backoff and lease ages are durations. Repositories stamp retry deadlines and compare lease ages
against PostgreSQL time; host clock skew cannot make a failure immediately due or steal a healthy
claim. Domain delivery, projection delivery, replay, reconciliation, auto top-up and promotion
maintenance use this rule. Provider business deadlines remain absolute timestamps.

The existing repository caps are enforced at startup. Lease, heartbeat, retry and retention policies
keep their current behavior. Erased accounts are excluded before bounding candidates.
Each claimed job checks its current ownership and the account's erasure state before materializing
or sending a payload. Removed, erased or no longer owned claims increment `skipped` in the run log
and `result="skipped"` on the projection and worker job counters, without a delivery result marker.
Usage-driven projections are one job per billing account whose payload is built when it is first
delivered and kept for retries, so the backlog is bounded by active accounts. Tune intervals and attempt limits with the `BILLING_*` variables listed
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

The metering maintenance worker deletes expired raw usage per project, in batches of its batch
size that each commit on their own, and by default keeps going for up to 20 seconds while batches come back
full, so a backlog drains within a poll. Expired idempotency claims and stored outcomes, worker
delivery claims and old catalog previews are swept the same way. Reservation expiry, allocation
periods, rollovers and rollup close commit first and are not rolled back by a failing sweep.
A raw usage event that a usage invoice adjustment references is kept past its window: the
adjustment's foreign key restricts the delete, and the event is the evidence for the invoiced
amount.

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
  `raw_usage_retention_days`, and upkeep resumes by itself once the default partition is empty
  (an event that a usage invoice adjustment references is kept, so a restore that put such an
  event there needs a reviewed plan instead).
  Do not detach or drop `usage_events_default`: other tables reference usage rows through foreign
  keys, so moving rows needs a reviewed maintenance plan.

Automatic top-up failures require resolving the payment/configuration cause before a protected
circuit reset. Use replay/retry routes for durable work; do not manually advance job state.

### Merchant platform retention

The merchant platform keeps short-lived operational rows that nothing else prunes. A runtime that
serves the merchant platform (`QUOTUM_CONSOLE_ENABLED=true`) schedules the `platform_retention` job
every 15 minutes by default. Headless runtimes schedule the same job for connection artifacts only.
The sweep reads PostgreSQL time. Each run deletes
rows older than these windows:

| Table | Deleted once | Window |
| --- | --- | --- |
| `platform_connection_versions` and `platform_connection_secrets` | Uncommitted draft expires; no active reference or live refresh lease | 7 days |
| `platform_connection_oauth_states` | `expires_at` or `consumed_at` is past | 7 days |
| `platform_connection_operations` | `created_at` is past, except permanent `credential.*` replay receipts | 30 days |
| `platform_stripe_app_events` | `processed_at` is past, or an unprocessed event has no current OAuth account/mode mapping and `created_at` is past | 30 days |
| `platform_rate_limits` | `reset_at` is past | 1 day |
| `platform_auth_links` | `expires_at` or `consumed_at` is past | 7 days |
| `platform_idempotency` | `created_at` is past, and the stored response is complete | 30 days |
| `platform_step_up_grants` | `expires_at` or `consumed_at` is past | 7 days |
| `platform_mcp_changes` | `created_at` is past, and the proposal is `completed`, `rejected`, `cancelled`, `expired`, `stale` or `failed`, or is still `pending` past its expiry | 30 days |
| `platform_mcp_authorizations` | `expires_at` or `revoked_at` is past, and no proposal refers to it | 30 days |

Rows younger than their window and rows still in use stay: a pending idempotency claim keeps
answering `OPERATION_IN_PROGRESS`, and a proposal that is `applying` or `needs_review` keeps its
grant. An elapsed rate-limit window already counts as empty, an expired link or grant is already
rejected, and a deleted idempotency record only ends replay of an answer older than 30 days. An
MCP connection whose row is gone answers like a revoked one, `MCP_AUTHORIZATION_REVOKED`. Audit
events, memberships, sessions, credentials and connections are never touched. Active and retired connection versions and their
secrets remain. Draft secrets and their parent version are deleted together. Connection receipt replay and processed Stripe event deduplication end after thirty days.
Credential rotation/revocation receipts remain indefinitely, so replay cannot rotate or revoke a
later key. Unmapped Stripe events remain quarantined for thirty days after receipt; reconnect or
investigate them before that deadline. Mapped unresolved events remain until processing succeeds.

Deauthorization reconciles the current installation using the app owner's mode-specific key and
`STRIPE_APP_ID`. An installed app keeps the connection; a complete empty installation list disables
it. Transitional states, partial/malformed responses and provider failures defer the event. The
connection's account, mode and active version are rechecked before the observation and event
completion commit together. An old event cannot disable a reinstalled app, and provider/database
clock skew or a missing event timestamp does not silently drop a legitimate revocation.

A run defaults to at most 1,000 rows per statement and 25 statements per table, each its own short
transaction that locks only the rows it removes and skips rows a request holds, so replicas share
the work and a sweep never blocks a request. A larger backlog drains over later runs. A run that
deleted anything logs `Platform retention sweep deleted expired rows` with the total (`deleted`),
one `{ table, deleted }` entry per table in `tables` and the tables that used every statement
(`capped`); a run that deleted nothing logs nothing. A failed table logs
`Platform retention sweep failed` with the table name, and the other tables are still swept. No
setting is involved; runs after an upgrade work through any existing backlog, up to 25,000 rows per
table each. Every column a window compares has an index, so a run finds its rows without scanning
a whole table.

### Subscription reconciliation retries

The reconciliation worker reads an Apple, Google or Stripe subscription back from the provider when
it was last reconciled more than `BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS` ago or is about to
expire. That read is what repairs a subscription after a lost provider notification. A read that
fails keeps its reason in `provider_reconciliation_error`, adds to
`provider_reconciliation_attempts` and waits before the next one: one minute after the first
failure, doubling with each. From the failure that reaches
`BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS` (default `10`) on, the wait stays at 24 hours,
so a subscription is read once a day for as long as the provider keeps failing and recovers by
itself when the provider does. It is never parked. A successful read clears the reason and the
count. Each poll claims at most 25 subscriptions, which bounds the provider calls a long outage
causes.

An earlier release parked a subscription whose attempts were spent (next attempt `infinity`) and
never read it again. Those rows are claimed on the first poll after upgrade and take a finite time
from their next result; no operator action is needed.

Find subscriptions whose reconciliation is failing with
`GET /v1/admin/subscriptions?needsAttention=true` (the rows carry `providerReconciliationAttempts`,
`providerReconciliationError` and `providerReconciliationNextAttemptAt`) or in SQL:

```sql
SELECT id, provider, status, provider_reconciliation_attempts,
	provider_reconciliation_error, provider_reconciliation_next_attempt_at
FROM subscriptions WHERE provider_reconciliation_error IS NOT NULL
ORDER BY provider_reconciliation_attempts DESC;
```

`POST /v1/admin/reconciliation/subscriptions/run` runs one pass without waiting for the poll; it
claims only subscriptions that are due.

### Recurring billing retries

The recurring billing worker applies due subscription changes and invoices closed usage windows
(periods and late adjustments). A job that fails goes back to `pending` with its reason in
`last_error` and waits before the next attempt: 1, 2, 4, 8, 16 and 32 minutes, then one hour. After
20 attempts, about 14 hours after the first failure, it is parked as `failed`. Parking a
subscription change releases the promotion use it reserved and fails the catalog migration job
waiting on it.

The window is deliberately shorter than the 24 hours Stripe keeps idempotency keys. Inside it every
retry repeats the keyed calls of the first attempt, so an invoice is created once. Stripe also
replays the first result of a key, an error included, for that long: a retry cannot see a recovery
on a call that already answered with a `5xx` or a card decline, and a failure that never reached
Stripe (network, rate limit, missing connection or configuration) is the kind a retry fixes.

Find parked jobs with:

```sql
SELECT 'subscription-change' AS kind, id::text AS id, attempts, last_error, updated_at
FROM subscription_changes WHERE status = 'failed'
UNION ALL SELECT 'usage-invoice-period', id::text, attempts, last_error, updated_at
FROM usage_invoice_periods WHERE status = 'failed'
UNION ALL SELECT 'usage-invoice-adjustment', id::text, attempts, last_error, updated_at
FROM usage_invoice_adjustments WHERE status = 'failed';
```

Fix the cause, then put a job back with a fresh budget through the operator routes
(`X-Billing-Operator-Key`): `POST /v1/admin/subscription-changes/:changeId/retry`,
`/v1/admin/usage-invoice-periods/:periodId/retry` or
`/v1/admin/usage-invoice-adjustments/:adjustmentId/retry`. Another project's job, or none, answers
`404`; one that is not `failed` answers `409 RECURRING_JOB_NOT_FAILED`. A parked change that carried
a promotion or a catalog migration, or whose subscription has a newer pending change, answers
`409 SUBSCRIPTION_CHANGE_NOT_RETRYABLE`: request the change again. A retry more than about ten hours
after parking runs after Stripe forgot the keys, so a usage invoice that had been created is created
again; void the earlier invoice, whose metadata names `usageInvoicePeriodId`. Jobs parked by an
earlier release after eight attempts can be requeued the same way.

### Default-plan passes

Every account without a paid base plan holds a default-plan grant: one grant row and one
entitlement row per key. Allowance rows exist only for the windows the account wrote in, so an
idle free account costs no rows and sends no projection when its allowance resets. A publish that
changes the default plan queues one pass over the project's customers. The subscription
reconciliation worker runs it after grant expiry: by default it scans 1,000 customers per slice,
changes up to its batch size of them, and spends at most ten slices per poll. Scan size and slice
count can be tuned independently, and a small scan resumes from its stored cursor. Reads and writes do not wait for
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
worker defaults to polling every ten seconds, selecting at most ten expired in-flight or reconciling operations.
Each observation claims a fresh 60-second lease, renewed every 20 seconds, and uses the recorded
connection version. Transient failures back off exponentially from ten seconds, capped at one hour;
after ten recovery attempts they require review. Ambiguous, absent or mismatched remote effects
require review immediately. Unavailable projects are deferred so they cannot starve eligible work.
`prepared` operations are dispatched only by a matching caller retry; automatic recovery never writes.

A Paddle write that is still `prepared` was never sent, so it can be released without asking
Paddle. The next checkout or preview for the account releases it, together with the account's open
checkout reservation when that has no operation or only this write, in two cases: the connection was
replaced since (a retry cannot dispatch under the recorded connection), or it has been idle for five
minutes and the request carries another key. The write is first marked `failed` with
`PROVIDER_OPERATION_NEVER_SENT`, so a late retry of its key finds a terminal receipt
(`409 PROVIDER_OPERATION_FAILED`) and can no longer dispatch it; the reservation closes as
`rejected`. A retry of the same key on the same connection still resumes the write, and a write
that was dispatched (`in_flight`, `reconciling`, `requires_review`) is never released this way.

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
is `PADDLE_RATE_LIMITED` (retry with a new key after the cooldown).
When Paddle answers `409 customer_already_exists`, the same operation resolves the customer Paddle
holds for the email, from the id in Paddle's error detail or else by an authenticated lookup by
email, and reads it back: it must be active and its email must match the checkout email,
ignoring case. The customer is linked to the billing account only if no other billing account in
the project already holds that Paddle customer id; the link is made inside the operation, so the
succeeded `customer.create` receipt carries the customer id (`result.linkedExisting`) and a replay
of the same checkout key returns the original outcome. Otherwise the receipt is terminal and the
checkout answers `409 PADDLE_CUSTOMER_ALREADY_EXISTS` with `details.reason`: `claimed` (another
account holds it), `inactive` (archived), `email_mismatch`, or `ambiguous` (more than one active
match, or no customer obtainable). Nothing is shared across accounts; use a different email under a
new key. Two accounts racing for one customer are decided by the unique
`(project, provider, external customer)` index on `provider_customers`: exactly one links it. These
reads use the same cooldown guard as every Paddle call; a rate limit or an unreachable Paddle while
reading fails the key (`PADDLE_RATE_LIMITED` or `PADDLE_UNAVAILABLE`), and a new key repeats the
lookup. If the process stops after the link but before the receipt settles, recovery observes the
linked customer and settles the receipt. A customer write that is still
unresolved (`prepared`, `in_flight`, `reconciling` or `requires_review`) blocks every other key with
`409 PROVIDER_OPERATION_PENDING` until it is reconciled; previews check the same condition before
reserving anything. Operations created before this change are keyed by the account alone: an
unresolved one with the same email is resumed by the next attempt, and a failed one no longer
blocks new keys.
While the process-wide Paddle rate-limit cooldown is active (set by any 429, including another
project's, because all projects share one egress IP), a checkout is refused before it reserves or
prepares anything, and so is a price read: `503 BILLING_PROVIDER_UNAVAILABLE` with
`details.retryAfterSeconds`, repeated in a `Retry-After` header (also through the console proxy).
No receipt records that refusal, so the same Idempotency-Key is retried unchanged once the
interval has passed. A price read that Paddle cannot answer (`5xx`, timeout) is
reported the same way instead of as `500 INTERNAL_ERROR`. A cooldown that begins in the few
milliseconds between that check and the write itself still refuses the write locally, and that
refusal is a failed receipt like any other definitive rejection: retry with a new key.
If local preparation fails after reservation, cleanup closes only a reservation with no bound
operation, recording `rejected`; binding is required before dispatch. Bound or ambiguous writes
keep their reservation. A locally rejected owner cannot dispatch again; start a fresh preview or
checkout key after correcting the local failure.

A signed body that is not a Paddle event (not JSON, a missing envelope field, an event type over
200 characters, or a NUL character) answers `400 INVALID_REQUEST` and queues nothing. Subscription
events and completed one-off transactions that carry no Quotum correlation, such as another product
on the same Paddle account, are ignored rather than retried.

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

### Stripe customer link repair

A billing account's Stripe customer link is written once and no worker changes it. Two situations
need an operator:

- A Stripe event stored as `skipped` or `failed` whose `processingError` starts with
  `stripe_customer_linked_to_other_account` or `stripe_account_linked_to_other_customer`.
  `GET /v1/admin/store-events?processingStatus=failed` lists the ones that ran out of retries.
- Checkouts for one account that answer `500 INTERNAL_ERROR` while the log shows Stripe's
  `No such customer`: the linked customer was deleted in Stripe.

1. Decide which side is wrong. Compare the event's customer and billing account with
   `GET /v1/admin/customers/by-billing-account/:billingAccountId` and with the customer in Stripe.
   When the event is the wrong one, leave the link alone and settle the payment in Stripe.
2. Clear what holds the link: let Stripe end the account's subscription, and let open payment
   setups, top-up jobs and usage invoices finish.
3. Send `POST /v1/admin/provider-customer-unlinks/:billingAccountId` with the linked customer id
   and a reason. `409 PROVIDER_CUSTOMER_LINK_IN_USE` names what is still open.
4. Send `POST /v1/admin/store-events/:eventId/replay` for the event, or let the account check out
   again.

[Unlinking a Stripe customer](providers.md#unlinking-a-stripe-customer) has the request, the
refusals and what the unlink leaves in place. Do not edit `provider_customers` rows by hand: the
unlink is the only change that leaves a receipt.

### Apple refund reversal repairs

Older Apple recording restored purchase and subscription state after `REFUND_REVERSED` while
leaving credit allocations reversed. Deploy the corrected service before repairing historical
events. This repair changes data in the existing schema; it requires no migration or event replay.

1. Run `quotum repair apple-refund-reversals report <instance>`. It opens the database directly
   using `POSTGRES_URI`, `QUOTUM_AUTH_SECRET` and `QUOTUM_SECRETS_KEY_ID`/`QUOTUM_SECRETS_KEY_BASE64`,
   as the connection commands do. Reports are read-only and return at most 100 processed reversal
   events; use `--limit <1-500>` and pass `nextAfter` as `--after <event-id>` to continue.
2. Inspect each event's `status`, allocation IDs, feature keys and `availableDelta`. `ready` means
   the original allocation can be restored; `unchanged` means no attributed reversed row remains.
   Expired rows may be restored with a zero balance delta. `blocked` includes a `reason`, such as
   `purchase_invalidated`, `later_invalidation` or `allocation_attribution_missing`.
   `refund_not_restorable` means the recorded history does not prove an eligible refund, including
   an independent revocation that predates the reversal even if the old recorder cleared its state.
3. Apply one selected event with
   `quotum repair apple-refund-reversals apply <instance> <store-event-id> --actor <name>`.
   `QUOTUM_ACTOR` may supply the actor. While the merchant platform runs, an organization with
   members also requires `--member-override-reason <why>`. Acceptance is recorded in the platform
   audit trail as `billing.action_accepted`, with `metadata.action = apple.refund_reversal.repair`
   and the store event ID.
4. Check `restoredAllocationIds`, the account's balance and delivery of its new `usage_changed`
   projection. Apply locks the account and rechecks eligibility, so its result can differ from an
   earlier report. It preserves consumption, reservations and original expiry. Repeating an
   applied repair changes no credits and queues no extra projection.

Reports or applications containing blocked events exit `2`; invalid arguments exit `64`, and
database or other operational failures exit `1`. Review `unattributedAllocationIds` manually:
subscription attribution compares the recorded refund's transaction timestamp with the allocation's
invalidation marker, retaining database microseconds. Missing history cannot be inferred safely.
An independent invalidation is left in place. A repair never changes store event processing status,
re-emits a purchase fact, or overrides a later refund or revocation. It does not run automatically
at startup. Resolve ambiguous history with provider evidence before making a separate correction.

### Customer erasure

An operator erases a billing account on the merchant's instruction, such as a data subject request.
It needs the [erasure keys](deployment.md#customer-erasure-keys); without them the three routes
answer `501 CUSTOMER_ERASURE_NOT_CONFIGURED`. All of them take the operator key and `X-Billing-Actor`,
and a read-only credential is refused.

1. `POST /v1/admin/customer-erasures/preview` with `{"billingAccountId": "…"}` returns `blockers`,
   the `forfeits` (features with purchased or granted balance still unspent, and lifetime purchases
   that still grant access), the `requiredAcknowledgements` those need and the rows it will touch.
2. Let the blockers finish. Every provider counts, and a subscription that funds a base plan blocks
   until it ends, including a store subscription Quotum cannot cancel. The other blockers are open
   provider operations, payment setups, checkouts and commercial actions, pending subscription
   changes and catalog migrations, reserved promotion redemptions, held usage reservations, top-up
   jobs, usage invoices, and a projection or webhook delivery in flight.
3. `POST /v1/admin/customer-erasures` with an `Idempotency-Key` and
   `{"billingAccountId": "…", "basis": "data_subject_request", "reference": "ticket-4411",
   "acknowledge": ["forfeit_paid_balances"]}`. `basis` is one of `data_subject_request`,
   `merchant_offboarding`, `legal_order` and `other`. `reference` is optional and kept in the
   receipt, so put a ticket number there, never a name. `409
   CUSTOMER_ERASURE_ACKNOWLEDGEMENT_REQUIRED` names what must be acknowledged and `409
   CUSTOMER_ERASURE_BLOCKED` what is still open. A replay of the same key and body answers `200`;
   the same key with another body answers `409 IDEMPOTENCY_CONFLICT`.
4. Read `GET /v1/admin/customer-erasures/:erasureId` until `state` is `completed`. The receipt has
   no billing account id and carries `counts` of the rows deleted or scrubbed per table.

The request freezes the account at once, in one transaction: its row becomes an anonymized stub
(the id is rewritten, the email and metadata cleared, `erased_at` set) and a tombstone is written.
For `BILLING_ERASURE_TOMBSTONE_DAYS` (30) every path that would create the id again answers
`409 BILLING_ACCOUNT_ERASED`, and a provider event that names it is dropped with its payload blanked;
after that the id is an ordinary new account. The `customer-erasure` worker then works in bounded
batches under a lease and resumes after a stop:

- deletes the account's provider links, checkout requests, payment setup sessions, idempotency
  claims, entitlements, projection jobs, outbound webhook events with their deliveries and closed
  Paddle reservations;
- rewrites ids, actors and free text on entities, provider operations, commercial action previews,
  promotion codes, plan grants, redemptions, operator grants, debits, balance allocation keys and
  refund requests (the account id, the caller's reason and both idempotency keys; the amounts,
  currency and provider ids stay);
- blanks provider payloads and error text on store events, purchases, subscriptions and invoices,
  and the receipt, window keys and caller metadata of usage events;
- verifies that nothing still carries the original id, then completes and drops the id from the
  operation row, the only place it lived until then.

Projection enqueues lock the account and check `erased_at` in the same transaction as the enqueue,
so an in-flight operation holding an internal customer id cannot add a job after the freeze.
Delivery admission shares the account lock with the erasure request: a delivery admitted first
blocks erasure as in flight, and a freeze admitted first suppresses delivery, including a stored
payload already held in worker memory. No transaction stays open during the HTTP request. Erased
claims are parked until the erasure deletes them; claims whose rows were already deleted are
skipped. Verification counts every remaining projection job, including null payloads and all
terminal statuses, and holds the account lock through the completion commit.

Quantities, ledger entries, usage windows and the purchase, subscription and invoice rows stay,
because the ledger must keep its integrity; only what names the person goes.

An operation in `failed` with `lastError: RESIDUAL_ROWS` found rows that still carried the id;
`counts` lists them as `residual.<table>`. Send the same `POST` again with the same key to queue it
once more. Any other failure backs off and retries by itself, and `lastError` holds a stable code,
never a message.

What an erasure does not do:

- It does not delete the customer in Stripe, Apple, Google or Paddle. Until the provider's customer
  is deleted, the provider can keep sending events; they are dropped when they name the id, but a
  payload that does not is stored like any other event.
- It does not reach platform copies: MCP change proposals, platform audit events and Stripe App
  events belong to the merchant platform.
- It does not reach backups. A database restored from before an erasure brings the account back,
  with its receipt rolled back too, so keep the list of erasures outside the database and run them
  again after a restore.
- It keeps caller-supplied dimension values on usage rows (`filters`, rate inputs). They must not
  carry personal data.

#### Historical projection cleanup

Older processes could enqueue or send a projection after the account was frozen, and complete an
erasure while projection rows or stored payloads remained. Drain and replace every old API and
worker process before resuming erasures or running this cleanup: a payload in an old worker's
memory can still be sent even after its row is deleted. This fix needs no schema migration or
environment changes. The cleanup removes only projection jobs belonging to an erased customer;
completed erasure receipts, active customers and accounting rows stay in place.

Using an operator database connection, preview the number of remaining jobs without selecting
their payloads or account identifiers:

```sql
SELECT count(*) AS remaining
FROM projection_sync_jobs jobs
JOIN customers customer
  ON customer.project_id = jobs.project_id AND customer.id = jobs.customer_id
WHERE customer.erased_at IS NOT NULL;
```

Run the following statement repeatedly. Each statement commits a batch of at most 500 jobs,
including stored payloads and every job status. It skips rows locked by another transaction.

```sql
-- Erased projection cleanup batch
WITH batch AS (
  SELECT jobs.project_id, jobs.id
  FROM projection_sync_jobs jobs
  JOIN customers customer
    ON customer.project_id = jobs.project_id AND customer.id = jobs.customer_id
  WHERE customer.erased_at IS NOT NULL
  ORDER BY jobs.created_at, jobs.id
  LIMIT 500
  FOR UPDATE OF jobs SKIP LOCKED
), deleted AS (
  DELETE FROM projection_sync_jobs jobs USING batch
  WHERE jobs.project_id = batch.project_id AND jobs.id = batch.id
  RETURNING jobs.id
)
SELECT count(*) AS deleted FROM deleted;
```

Re-run the preview after each batch. Finish only when `remaining` is zero: `deleted = 0` can mean
that another transaction still locks the remaining rows. Repeating the cleanup is safe. A running
erasure that fails with `RESIDUAL_ROWS` retains its subject id and can be queued again using its
original request and idempotency key.
