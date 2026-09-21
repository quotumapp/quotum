# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Quotum is a Bun/TypeScript/Elysia billing API on a single Postgres database. Product backends call
authenticated `/v1` APIs and consume signed projections; the merchant web app talks to `/api`.
`AGENTS.md`, `CONTRIBUTING.md`, and the guides under `docs/` are the longer-form references and
are kept current; do not duplicate them here, update them when behavior changes.

## Commands

Bun `>=1.4.0 <1.5.0` only. Docker is required for every Postgres-backed lane.

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

bun run openapi:generate && bun run openapi:check && bun run openapi:lint   # after any route or capability change

bun run mcp                      # read-only stdio MCP server; QUOTUM_MCP_BASE_URL + read-only (or sandbox) QUOTUM_MCP_API_KEY
```

Postgres-backed test files are wrapped in `describeLocalPostgres` / `describeE2e` and silently
skip under plain `bun test` unless `RUN_POSTGRES_INTEGRATION_TESTS=1` or `RUN_BILLING_E2E_TESTS=1`
is set. Always use the `test:*` runner scripts for those lanes; they start the container, verify
migration checksums, apply migrations, bootstrap test projects, and export the required
`BILLING_TEST_*` JSON env vars.

`bun run openapi:check` fails CI if `contracts/v1/openapi.json`, `contracts/v1/errors.json`,
`contracts/v1/provider-capabilities.json` or the generated capability table in `docs/providers.md`
is stale, so regenerate and commit them with any HTTP change and any change to a provider
capability declaration (`src/providers/*/capabilities.ts`) or the capability vocabulary
(`src/shared/provider-capabilities.ts`).

## Architecture

### Two HTTP surfaces, one process

- `src/index.ts` -> `src/composition/public-runtime.ts` (`createQuotumRuntime`) ->
  `src/runtime.ts` (`createBillingRuntime`) builds everything: repositories, provider services,
  seven polling workers, shutdown hooks, then the "staff" Elysia app from `src/app.ts` (`createApp`)
  and the merchant app, composed by `composeRuntimeApp` in `src/composition/merchant-runtime.ts`.
  `runtime.app.fetch(request, server)` must receive Bun's server so client-IP limits work.
- `/v1/*` is the trusted-backend API (`src/app/*-routes.ts`). Authentication is a project
  credential resolved in the staff app's authentication `derive` into a `ProjectInstanceContext`
  exposed to handlers as `project`; every repository call takes that context first. Operator-only
  admin routes additionally require `X-Billing-Operator-Key`.
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
- `src/mcp` (the read-only stdio MCP server, see `docs/mcp.md`) is its own owner: it may import only
  `src/mcp`, `src/shared` and `src/sdk`, and no domain module may import it. Every request it can
  send is listed in `src/mcp/guarded-fetch.ts`; `tests/mcp/inventory.test.ts` pins the tool list
  against that allowlist, so add a tool and its route together and never add a write.
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

The HTTP layer is Elysia (`src/app.ts` staff shell, `src/platform/app.ts` merchant shell). Every
route is registered directly with `app.get/post/put/patch/delete(path, handler, config)`; the
config carries Zod `body`/`query`/`params` schemas (Elysia validates them before the handler;
failures map to a 400 `INVALID_REQUEST` envelope) and `detail: operationDetail(...)` from
`src/shared/http.ts`. Handlers that validate input themselves document it with
`operationDetail({ request: { body, query } })`.

- Every Elysia instance uses `HTTP_APP_CONFIG` (`strictPath`). Gates, guards and limiter keys match
  the routed path (`path` in hooks, `routedPath`), never `new URL(request.url).pathname`, which can
  differ from what Elysia routed.
- Private `/v1` bodies use `parse: [LENIENT_JSON_PARSE]`: every content type is read under the
  256 KB cap and parsed as JSON. Parsers run before authentication, and a parser that returns
  `undefined` for a request with a body lets Elysia fall through to its uncapped form, multipart
  and binary parsers. Merchant bodies use `MERCHANT_JSON_PARSE` (64 KB, 415 for non-JSON);
  operations that never read a body declare `parse: "none"`. Raw-body routes (webhooks, Better
  Auth, billing proxy) use `parse: "none"` and the capped readers in `src/shared/body-limit.ts`.
  A route without an explicit parser is not body-less: Elysia's built-in parsers read the whole
  body before authentication. `tests/http/route-body-parsers.test.ts` checks every non-GET route
  in the documented apps for one of these bounded parsers.
- Rate limiting runs before validation: webhook and aggregate gates in the shell's `onRequest`,
  project-keyed and operator-key guards via `registerPostAuthGuard` inside the authentication
  `derive`. Project selector checks on bodies run as a route `transform`, before validation strips
  unknown keys.
- `src/composition/openapi.ts` renders `contracts/v1/openapi.json` from the registered routes: Zod
  request and response schemas, required headers derived from the path, and named components
  (`<operationId>Response<status>` plus merchant/provider domain schemas that `quotum-ui` imports).
  CI runs `oasdiff breaking` against the base revision.
- Tests wrap apps with `withOpenApiAssertions`, so an undocumented status code, a response that
  does not match its schema, or a successful request whose body does not match the documented
  request schema fails the test, not just the contract check.

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
recurring billing, auto top-up, promotion maintenance, plus Stripe App event processing when Apps
OAuth is configured. Workers lease job rows by `worker_id` (`locked_by` columns,
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
- Conventional Commits, subject under 72 characters. Do not bump the `package.json` version in
  feature pull requests; it stays at `0.0.0-dev`. Releases tag an existing verified `main` commit,
  without a release branch or version-bump PR. For releases, follow
  [the publishing checklist](docs/operations.md#publish-a-container-release): push the chosen
  Git tag to GitHub and verify the GitHub Release and the versioned GHCR image. A version bump or
  `main` push alone does not publish a versioned image. PR titles are the squash commit subject,
  checked by `PR title` and mapped to release-note labels by `scripts/release.ts`. Release notes
  are GitHub's generated pull request list; upgrade details belong in pull request descriptions.
  `CHANGELOG.md` is frozen at 0.10.1. See [AGENTS.md](AGENTS.md#releases-and-container-publishing).
- `tests/package-scripts.test.ts` pins the exact text of several package scripts, the Dockerfile,
  and `src/migrate.ts` safety patterns. Changing those requires updating that test deliberately.
- Migrations, bootstrap credential output, credential handling, and provider webhook verification
  are security-sensitive; add focused tests when touching them.
- Never bypass migration integrity checks or reset populated production data as a routine upgrade.
