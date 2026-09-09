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
bun run migrate:status
```

Every applied migration must have a matching local file and checksum. A missing applied file or a
checksum mismatch fails both `migrate:status` and `migrate`; use the release matching the backup.

## Schema and upgrade policy

The current schema is initialized from these ordered baseline files:

<!-- migration-inventory:start -->
| File | Owns |
| --- | --- |
| [001_platform.sql](../migrations/001_platform.sql) | Organizations, projects, instances, credentials and customer connections |
| [002_billing_core.sql](../migrations/002_billing_core.sql) | Billing accounts, purchases, subscriptions, entitlements and provider/projection jobs |
| [003_metering_and_pricing.sql](../migrations/003_metering_and_pricing.sql) | Catalog, metering, operation recovery, pricing, controls and commercial actions |
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

## Upgrade

1. Read the target version's entry in [CHANGELOG.md](../CHANGELOG.md) and the
   [schema policy](#schema-and-upgrade-policy). Establish database compatibility before rollout.
2. Take a backup.
3. If the entry says so, stop usage writers and workers on the old version.
4. Run `bun run migrate:status` from the target image. Stop if integrity verification fails;
   follow the schema policy before proceeding. On a compatible or freshly recreated disposable
   database, run `bun run migrate`. The runner takes an advisory lock, applies pending files in
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

## Health, readiness, and metrics

- `GET /livez` is a static liveness check; `/health` is a public alias.
- `GET /ready` checks database reachability and the required platform schema. Customer integration
  readiness is separate and never gates the process.
- `GET /metrics` is a public non-customer-labelled Prometheus registry in the current API; apply
  ingress restrictions if this endpoint should be private in a deployment.
- `GET /v1/admin/metrics` returns the registry through the project-authenticated admin boundary
  and requires `X-Billing-Operator-Key`. Health routes are public.

## Workers

One process runs the HTTP API and all workers: projection delivery, provider event replay,
subscription reconciliation, metering maintenance (reservation expiry, rollovers, rollup close,
retention sweeps), recurring billing, and automatic top-ups. Replicas coordinate through leased jobs with
heartbeats; projection delivery claims up to 25 jobs per poll from a candidate set bounded by the
batch size and delivers five concurrently. Usage-driven projections are one job per billing account
built at delivery, so the backlog is bounded by active accounts. Tune intervals and attempt limits
with the `BILLING_*` variables listed in [deployment.md](deployment.md#optional-variables).

Raw usage is partitioned monthly. Technical retention uses `metering_settings.raw_usage_retention_days`
(default 400); durable monthly rollups outlive deleted raw rows. This default is not a legal
retention guarantee or an implemented versioned privacy policy.

Automatic top-up failures require resolving the payment/configuration cause before a protected
circuit reset. Use replay/retry routes for durable work; do not manually advance job state.
Stripe app-event polling runs when the Apps OAuth integration is configured.

## Load lane

`bun run test:load` boots the real service and drives the metering hot path over HTTP with a
closed-loop client. It creates a disposable Postgres container only when neither `--postgres-uri`
nor `POSTGRES_URI` is set. An environment value, including one loaded by Bun, selects an existing
database; `--postgres-uri` overrides it. **The selected database is migrated, bootstrapped and its
billing tables are reset. Use only a disposable database.** A reused target keeps its earlier bootstrap
and issues no fresh credential; add `--recreate-schema` to drop and recreate its `public` schema
first.

The lane publishes a metered catalog and grants balances to one hot account and, by default,
1,000 spread accounts. Scenarios are `hot` (one account, one feature), `spread` (round-robin),
`reserve` (reserve then confirm), `check`, and `workers-off` (hot and spread with worker polling
intervals extended to one hour). The last scenario keeps polling idle during short runs; it does
not permanently disable workers. Keep `workers-off` last in a custom scenario list because later
scenarios do not restore the normal polling intervals.

Results include client latency percentiles, scenario iterations and ledger calls per second,
Postgres transactions, WAL bytes, dead tuples, sampled lock waits, projection jobs created,
delivered and left in backlog, and sampled service/container CPU. A successful reserve iteration
makes two HTTP calls; its client latency covers reserve plus confirm, while server percentiles
use the confirm operation's histogram. Server percentiles are histogram bucket upper bounds.
Statement counts and database time per request are aggregate ratios from `pg_stat_statements`,
not isolated attribution to each HTTP request. These values can be unavailable when the extension
or its reset is unavailable. CPU values can also be unavailable; an existing database has no
container CPU sample.

`--profile [consume|check]` skips the scenarios, runs fifty sequential requests against the hot
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

Quotum is pre-1.0. Each release must be tagged `vX.Y.Z`, listed in the changelog with its migrations
and upgrade order, and published as a container image with the same version using the checklist
below. Only the latest release line receives fixes, published as a new patch on `main`. Security
issues are handled privately; see [SECURITY.md](../SECURITY.md).

## Publish a container release

The [Publish image workflow](../.github/workflows/docker-publish.yml) publishes
`ghcr.io/quotumapp/quotum` for `linux/amd64` and `linux/arm64`:

| GitHub push | Container tags |
| --- | --- |
| Commit on `main` | `main` (rolling development image) |
| Stable release tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `latest` |

The workflow rejects a release tag that differs from `v` plus the tagged commit's `package.json`
version. A package version bump or a `main` push alone does not publish versioned image tags.
Git tags already present on GitHub do not prove that an image was built. The workflow listens to
pushes; it has no GitHub Release event or manual dispatch trigger. Publishing runs independently of
[CI](../.github/workflows/ci.yml) and does not wait for its checks.

1. Prepare the release commit on `main`: update `package.json` and [CHANGELOG.md](../CHANGELOG.md),
   including migration compatibility, environment changes and upgrade order. Complete
   [release verification](#release-verification) for this revision and commit the release files.
2. From a clean checkout of that `main` revision, verify the GitHub remote and push the commit.
   These examples use `github` for `quotumapp/quotum`; substitute the actual GitHub remote name
   if different. In the multi-repository workspace, `origin` may point to GitLab; a push there
   does not trigger GitHub image publishing. The commands use Git, `jq`, GitHub CLI and Docker
   Buildx. Keep the release variables in the same shell through the remaining steps.

   ```sh
   git remote -v
   release_commit=$(git rev-parse HEAD)
   git push github main
   gh run list --repo quotumapp/quotum --workflow ci.yml --commit "$release_commit"
   ```

   Wait for CI to succeed for this exact commit before continuing. A successful `main` image
   build alone is not the release verification gate.
3. Read the committed version, create its matching annotated tag on the verified commit, and
   push that one tag to GitHub:

   ```sh
   release_version=$(git show "${release_commit}:package.json" | jq -r .version)
   git tag -a "v$release_version" "$release_commit" -m "Release v$release_version"
   git push github "refs/tags/v$release_version"
   ```

   Push release tags individually: GitHub does not emit tag push events when more than three
   tags are pushed together. See [GitHub's push event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).
   Do not move an existing release tag to another commit.
4. Find the `Publish image` run for the new `vX.Y.Z` tag and wait for success. The same commit
   can also have a `main` publishing run, so check the run's ref:

   ```sh
   gh run list --repo quotumapp/quotum --workflow docker-publish.yml --commit "$release_commit"
   ```

5. Confirm the version, minor and `latest` tags in [GHCR package versions](https://github.com/quotumapp/quotum/pkgs/container/quotum/versions).
   Inspect the versioned image and record its top-level digest with the release commit and
   publishing run URL:

   ```sh
   docker buildx imagetools inspect "ghcr.io/quotumapp/quotum:$release_version"
   ```

   Verify both target platforms and that the three release tags resolve to the same digest at
   publication time. Use the recorded digest to pin deployments; `main`, `X.Y` and `latest` move
   as subsequent builds are published. A release is published only after the versioned image is
   verified in GHCR. Follow [Upgrade](#upgrade) separately to deploy it.
