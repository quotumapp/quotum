# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The import above loads the rules shared by every contributor and agent: layout, commands, style,
testing, commits, releases and security. This file adds how the runtime fits together and the
repository checks that most often reject a change. `CONTRIBUTING.md` and the guides under `docs/`
are the longer-form references and are kept current; do not duplicate them here, update them when
behavior changes. CodeRabbit reviews pull requests against this file and `AGENTS.md`
(`.coderabbit.yaml`), so change both together with the behavior they describe.

## Architecture

### One process, several HTTP surfaces

- `src/index.ts` -> `src/composition/public-runtime.ts` (`createQuotumRuntime`) ->
  `src/runtime.ts` (`createBillingRuntime`) builds everything: repositories, the provider registry,
  seven polling workers, shutdown hooks, then the "staff" Elysia app from `src/app.ts`
  (`createApp`) and, through `attachMerchantRuntime` in `src/composition/merchant-runtime.ts`, the
  merchant app. `composeRuntimeApp` there routes setup-only ingress (connection and Stripe App
  events) first, then the remote MCP and OAuth endpoints when enabled, `/api/*` to the merchant
  app and everything else to the staff app. `runtime.app.fetch(request, server)` must receive
  Bun's server so client-IP limits work. With `QUOTUM_MERCHANT_ENABLED=false` (headless),
  `loadOptionalMerchantConfig` returns `null` and `attachHeadlessRuntime` mounts only the ingress
  and the staff app: no `/api/*`, remote MCP or merchant settings.
- `/v1/*` is the trusted-backend API (`src/app/*-routes.ts`). The staff app's authentication
  `derive` resolves a project credential (`BILLING_AUTH_MODE=api_key`) or the trusted gateway's
  project header (`gateway`) into `project`, a `ProjectInstanceContext` that every repository call
  takes first, plus `credentialAccess`. A read-only credential reaches only routes that opt in
  with `operationDetail({ credentialAccess: "read_only" })`; any other route answers
  `403 READ_ONLY_CREDENTIAL`. Operator-only admin routes additionally require
  `X-Billing-Operator-Key`, and audited mutations `X-Billing-Actor`.
- `/api/*` is the merchant platform (`src/platform/app.ts`): Better Auth sessions, organizations,
  onboarding, provider connections. Merchant billing screens do not call billing code directly;
  they dispatch through `MerchantBillingPort` (`src/platform/application/billing-port.ts`), which
  `src/composition/merchant-billing.ts` implements by mapping operations onto the same `/v1`
  handlers and schemas.
- The package exports `quotum-api/runtime` and `quotum-api/testing/merchant` are public interfaces
  for a hosted distribution: construction starts no background work, one runtime is active per
  process, and a stopped runtime cannot restart. Read `docs/architecture.md` before changing them.

### Module boundaries are enforced, deny-by-default

`bun run check:boundaries` (`scripts/lib/module-boundaries.ts`) assigns every TypeScript file in
the repository to exactly one owner and inspects every SQL migration. A new file that matches no
owner, such as a new `scripts/*.ts`, fails until it is classified there. The rules that most often
bite:

- Billing (`src/admin`, `src/app`, `src/billing`, `src/catalog`, `src/db`, `src/http`,
  `src/observability`, `src/operations`, `src/projects`, `src/projections`, `src/providers`,
  `src/sdk`, `src/workers`, `src/env.ts`) and Platform (`src/platform`) never import each other,
  not even through the package's own SDK export. Only composition (`src/composition`, including
  the operator commands in `src/composition/cli`, the root entrypoints such as `src/app.ts`,
  `src/cli.ts` and `src/runtime.ts`, and a few scripts) and test support may import both.
- `src/mcp` is its own owner: it may import only `src/mcp`, `src/shared` and `src/sdk`, and no
  domain module may import it.
- `src/shared` depends on nothing domain-specific. Production code never imports `src/composition`
  or `src/testing`.
- Platform, shared and MCP code cannot use Drizzle, Postgres clients, Bun SQL or `src/db`; the one
  exception is `src/platform/persistence/auth-schema.ts`, which declares the Better Auth tables
  with `drizzle-orm/pg-core`. Platform repositories get a `PlatformQueryExecutor` from composition
  and must call `executor.query({ text, values })` with an inline string literal; computed or
  concatenated SQL is rejected.
- Platform tables are `platform_*`. Platform SQL may reference only those tables; billing source
  and every migration except `001_platform.sql` and `004_merchant.sql` may not touch them. The
  single cross-domain SQL file is `src/composition/project-instance-persistence.ts`. Dynamic SQL
  in migrations is denied outside the reviewed block in `003_metering_and_pricing.sql`. See
  `docs/architecture.md`.

If the checker rejects an import it usually means the file is in the wrong owner directory, not
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
  Auth, billing proxy, remote MCP) use `parse: "none"` and the capped readers in
  `src/shared/body-limit.ts`. A route without an explicit parser is not body-less: Elysia's
  built-in parsers read the whole body before authentication.
  `tests/http/route-body-parsers.test.ts` checks every non-GET route in every route table (staff,
  merchant, remote MCP and ingress apps) for one of these bounded parsers.
- Rate limiting runs before validation: webhook and aggregate gates in the shell's `onRequest`,
  project-keyed and operator-key guards via `registerPostAuthGuard` inside the authentication
  `derive`. Project selector checks on bodies run as a route `transform`, before validation strips
  unknown keys.
- `src/composition/openapi.ts` renders `contracts/v1/openapi.json` from the registered staff and
  merchant routes (Zod request and response schemas, required headers derived from the path, and
  named components: `<operationId>Response<status>` plus merchant/provider domain schemas that
  `quotum-ui` imports), then merges hand-written paths for Better Auth
  (`src/composition/auth-openapi.ts`) and the remote MCP and OAuth endpoints
  (`src/composition/remote-mcp-openapi.ts`); update those files when you change those routes.
  CI publishes an `oasdiff breaking` report against the base revision.
- `contracts/v1/errors.json` inventories every error-code literal in `src/` outside `src/mcp` and
  `src/testing`, so adding or renaming a code fails `openapi:check` until you regenerate, even
  when no route changed.
- Tests wrap apps with `withOpenApiAssertions`, so an undocumented status code, a response that
  does not match its schema, or a successful request whose body does not match the documented
  request schema fails the test, not just the contract check.

### Persistence

- `src/db/schema.ts` is the Drizzle mirror of the SQL under `migrations/`; SQL is authoritative,
  keep both in step.
- `BillingRepository` (`src/db/repository.ts`) is a facade over per-domain repositories in
  `src/db/repository/`. `repository.forProject(context)` returns a `ProjectScopedBillingRepository`
  that providers and workers use so tenancy cannot be forgotten.
- `tests/db/tenant-sql-guard.test.ts` fails when a tagged SQL template in `src/db` touches a table
  with a `project_id` column without mentioning `project_id`. Scope the statement, or add an
  allowlist entry with its reason; an entry that no longer matches fails too.
- Bind JSON as text and cast on the server (the `jsonb()` helper in `src/db/repository/query.ts`);
  a bare `::jsonb` cast on a string parameter is encoded twice. `CONTRIBUTING.md` also sets the
  ordering rules for `Promise.all` inside a transaction.
- `src/migrate.ts` takes a Postgres advisory lock, verifies SHA-256 checksums of already-applied
  files, and runs `CREATE INDEX CONCURRENTLY` files outside a transaction. Before 1.0 the domain
  baselines evolve in place and disposable databases are recreated; incremental migrations start
  at 1.0. Follow `docs/operations.md` for compatibility and populated-database transitions.
- Unit tests under `tests/db` assert rendered SQL via `tests/helpers/drizzle-sql.ts` without a
  database; real behavior lives in `tests/integration`.

### Workers and projections

`createBillingRuntime` schedules each worker's `runOnce` with `startPollingRuntime`
(`src/workers/runtime.ts`) unless a distribution supplies its own scheduler: projection sync,
store-event replay, subscription reconciliation, metering maintenance, recurring billing, auto
top-up, promotion maintenance, plus Stripe App event processing when Apps OAuth is configured.
Workers lease job rows by `worker_id` (`locked_by` columns, refreshed by
`src/workers/lease-heartbeat.ts`) and retry with `src/workers/backoff.ts`, so a worker must only
touch rows it holds. Projection sync delivers signed `billing_state_v1` payloads to each project's
configured projection URL via `src/projections/http-client.ts`. Provider credentials and
projection secrets are encrypted, database-owned connections resolved per project by
`RuntimeConnectionResolver`; there is no env-level customer list, and
`BILLING_PROJECT_RUNTIME_JSON` / `BILLING_PROJECTS_JSON` are rejected on purpose.

### MCP

`src/mcp/` holds the read-only tools, the contract tools and the stdio entrypoint (`bun run mcp`).
Every API request a tool sends goes through `createGuardedFetch` (`src/mcp/guarded-fetch.ts`),
whose `allowedRequests` list is the complete set of calls either transport can make. The optional
remote transport (`QUOTUM_MCP_ENABLED`, `QUOTUM_MCP_PUBLIC_ORIGIN`) is
`src/composition/remote-mcp.ts`: it serves `/mcp` and the OAuth endpoints in the API process,
verifies grants issued by `src/platform/mcp/`, and dispatches the same guarded requests through
`MerchantBillingPort` (`src/composition/mcp-port-fetch.ts`) without a project key. A new tool
needs its route in `allowedRequests` (`tests/mcp/inventory.test.ts` pins tools against the
allowlist), a `/v1` route that opts into read-only credentials
(`tests/mcp/contract-allowlist.test.ts`), and a `merchantBillingOperations` entry handled by
`src/composition/merchant-billing.ts` (`tests/mcp/port-fetch.test.ts`). Never add a write.

### Test entrypoints

`src/testing/test-*-entrypoint.ts` start the real runtime with test doubles.
`test-stripe-entrypoint.ts` (`bun run test:stripe-entrypoint`, used by `docs/quickstart.md`) and
`test-merchant-entrypoint.ts` use fake providers, captured mail and in-memory connections from
`BILLING_TEST_CONNECTIONS_JSON`; `test-runtime-entrypoint.ts` is the process the e2e lane spawns,
with loopback projection delivery. Each throws unless `BILLING_ENV=test` plus its matching
`BILLING_TEST_*` / `MERCHANT_TEST_MODE` flags are set; do not loosen those guards.

## Conventions worth knowing

`tests/package-scripts.test.ts` pins the exact text of several package scripts, the lane runners
and Postgres container helper, the Dockerfile, and `src/migrate.ts` safety patterns. Changing
those requires updating that test deliberately.
