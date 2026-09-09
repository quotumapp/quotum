# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Quotum is a Bun/TypeScript/Hono billing API on a single Postgres database. Product backends call
authenticated `/v1` APIs and consume signed projections; the merchant web app talks to `/api`.
`AGENTS.md`, `CONTRIBUTING.md`, and the guides under `docs/` are the longer-form references and
are kept current; do not duplicate them here, update them when behavior changes.

## Commands

Bun `>=1.4.0 <1.5.0` only (`packageManager` pins 1.4.2). Docker is required for every
Postgres-backed lane.

```sh
bun install --frozen-lockfile
bun run dev                      # hot-reloading server on PORT (default 3000)
POSTGRES_URI=... bun run migrate  # apply ordered SQL migrations; `migrate:status` to inspect

bun run quality                  # check:boundaries + typecheck + lint + format:check (CI gate)
bun run quality:fix              # biome lint --write + format
bun run check:boundaries         # module/table ownership checker alone

bun run test                     # unit suite = `bun test tests` (no Docker)
bun test tests/billing/metering.test.ts       # one file
bun test tests/billing/metering.test.ts -t "ceiling"  # filter by test name

bun run test:integration         # disposable Postgres container, runs tests/integration
bun run test:integration tests/integration/metering-flows.test.ts   # one integration file
bun run test:e2e                 # boots the real service process against a container
bun run test:merchant:integration   # integration/merchant against a container

bun run openapi:generate && bun run openapi:check && bun run openapi:lint   # after any route change
```

Postgres-backed test files are wrapped in `describeLocalPostgres` / `describeE2e` and silently
skip under plain `bun test` unless `RUN_POSTGRES_INTEGRATION_TESTS=1` or `RUN_BILLING_E2E_TESTS=1`
is set. Always use the `test:*` runner scripts for those lanes; they start the container, verify
migration checksums, apply migrations, bootstrap test projects, and export the required
`BILLING_TEST_*` JSON env vars.

`bun run openapi:check` fails CI if `contracts/v1/openapi.json` or `contracts/v1/errors.json` is
stale, so regenerate and commit them with any HTTP change.

## Architecture

### Two HTTP surfaces, one process

- `src/index.ts` -> `src/runtime.ts` (`createBillingRuntimeApp`) builds everything: repositories,
  provider services, six polling workers, shutdown hooks, then the "staff" Hono app from
  `src/app.ts` (`createApp`) and the merchant app via `src/composition/merchant-runtime.ts`.
- `/v1/*` is the trusted-backend API (`src/app/*-routes.ts`). Authentication is a project
  credential resolved by `requireApiKey` into a `ProjectInstanceContext` stored on
  `c.get("project")`; every repository call takes that context first. Operator-only admin routes
  additionally require `X-Billing-Operator-Key`.
- `/api/*` is the merchant platform (`src/platform/app.ts`): Better Auth sessions, organizations,
  onboarding, provider connections. Merchant billing screens do not call billing code directly;
  they dispatch through `MerchantBillingPort` (`src/platform/application/billing-port.ts`), which
  `src/composition/merchant-billing.ts` implements by mapping operations onto the same `/v1`
  handlers and schemas.

### Module boundaries are enforced, deny-by-default

`bun run check:boundaries` (`scripts/lib/module-boundaries.ts`) parses every TS file and SQL
migration. The rules that most often bite:

- Billing (`src/app`, `src/billing`, `src/catalog`, `src/db`, `src/providers`, `src/workers`,
  `src/projections`, `src/projects`, `src/http`, `src/admin`, `src/operations`, `src/sdk`,
  `src/env.ts`) and Platform (`src/platform`) never import each other. Only `src/composition`,
  the root entrypoints, and test support may import both.
- `src/shared` depends on nothing domain-specific. Production code never imports `src/composition`
  or `src/testing`.
- Platform code cannot touch Drizzle, Bun SQL, or billing persistence. Platform repositories get a
  `PlatformQueryExecutor` from composition and must call `executor.query({ text, values })` with
  static inline SQL; concatenated SQL is rejected.
- Platform tables are `platform_*`; billing SQL and migrations may not reference them. The single
  cross-domain SQL file is `src/composition/project-instance-persistence.ts`.
- `001_platform.sql` and `004_merchant.sql` own the platform schema; billing baselines cannot touch
  `platform_*` tables. See `docs/architecture.md` for the current ownership rules.

If the checker rejects a new file it usually means the file is in the wrong owner directory, not
that the rule needs an exception.

### HTTP contract pipeline

Every route is declared with `defineContract(method, path, { operationId, tags, body, params,
query, responses })` from `src/shared/http-contract.ts` and mounted with `registerRoute(app,
contract, handler)`. `defineContract` derives security schemes, standard error responses, and
required headers (`Idempotency-Key`, `X-Billing-Actor`, `Origin`) from the path prefix and tags.
Route modules export their contracts map (e.g. `meteringContracts`);
`src/composition/openapi.ts` collects them all into `contracts/v1/openapi.json`. Integration
tests wrap the app with `withOpenApiAssertions`, so an undocumented status code or a response
that does not match its Zod schema fails the test, not just the contract check.

### Persistence

- `src/db/schema.ts` is the Drizzle mirror of the SQL under `migrations/`; SQL is authoritative,
  keep both in step.
- `BillingRepository` (`src/db/repository.ts`) is a facade over per-domain repositories in
  `src/db/repository/`. `repository.forProject(context)` returns a `ProjectScopedBillingRepository`
  that providers and workers use so tenancy cannot be forgotten.
- `src/migrate.ts` takes a Postgres advisory lock, verifies SHA-256 checksums of already-applied
  files, and runs `CREATE INDEX CONCURRENTLY` files outside a transaction. Before 1.0 the domain
  baselines evolve in place and disposable databases are recreated; incremental migrations start
  at 1.0. Follow `docs/operations.md` for compatibility and populated-database transitions.
- Unit tests under `tests/db` assert rendered SQL via `tests/helpers/drizzle-sql.ts` without a
  database; real behavior lives in `tests/integration`.

### Workers and projections

`src/workers/runtime.ts` (`startPollingRuntime`) runs each worker's `runOnce` on an interval:
projection sync, store-event replay, subscription reconciliation, metering maintenance,
recurring billing, auto top-up. Workers lease job rows by `worker_id` (`locked_by` columns,
refreshed by `src/workers/lease-heartbeat.ts`) and retry with `src/workers/backoff.ts`, so a
worker must only touch rows it holds. Projection sync delivers signed `billing_state_v1`
payloads to each project's configured projection URL via `src/projections/http-client.ts`.
Provider credentials and projection secrets are encrypted, database-owned connections resolved
per project by `RuntimeConnectionResolver`; there is no env-level customer list, and
`BILLING_PROJECT_RUNTIME_JSON` / `BILLING_PROJECTS_JSON` are rejected on purpose.

### Test entrypoints

`src/testing/test-*-entrypoint.ts` start the real runtime with fake Stripe/Google/mail and
in-memory connections from `BILLING_TEST_CONNECTIONS_JSON`. They throw unless `BILLING_ENV=test`
plus the matching `BILLING_TEST_*` / `MERCHANT_TEST_MODE` flags are set; do not loosen those
guards. The quickstart in `docs/quickstart.md` uses `bun run test:stripe-entrypoint`.

## Conventions worth knowing

- Biome: tabs, 100 columns, double quotes, organized imports. `contracts/v1` is excluded from
  formatting because it is generated.
- Strict TypeScript, kebab-case file names, `*.test.ts` under `tests/` mirroring `src/`.
- Conventional Commits, subject under 72 characters. Bump `package.json` version when a change
  ships; CI warns on an unchanged version. For releases, follow
  [the publishing checklist](docs/operations.md#publish-a-container-release): push the matching
  Git tag to GitHub and verify the versioned GHCR image. A version bump or `main` push alone
  does not publish a versioned image. See [AGENTS.md](AGENTS.md#releases-and-container-publishing).
- `tests/package-scripts.test.ts` pins the exact text of several package scripts, the Dockerfile,
  and `src/migrate.ts` safety patterns. Changing those requires updating that test deliberately.
- Migrations, bootstrap credential output, credential handling, and provider webhook verification
  are security-sensitive; add focused tests when touching them.
- Never bypass migration integrity checks or reset populated production data as a routine upgrade.
