# Repository Guidelines

Guidance for contributors and coding agents working in this repository. The longer form lives in
[CONTRIBUTING.md](CONTRIBUTING.md) and the guides under [docs/](docs/), which describe current
behavior; update the owning guide in place instead of restating it here. This is the one agent
guide: `CLAUDE.md` only imports it for Claude Code, and CodeRabbit reviews pull requests against
it (`.coderabbit.yaml`), so change it together with the behavior it describes.

## Project structure

Bun/TypeScript/Elysia billing service backed by one Postgres database. One process serves the
trusted-backend `/v1` API, the merchant platform under `/api`, provider webhooks and, when
enabled, the remote MCP endpoint, and it runs the background workers. Runtime code lives in `src/`:

- `app.ts`, `app/`: the `/v1` API that product backends call.
- `platform/`: organizations, identity, onboarding, connections, audit and MCP browser
  authorization, behind consumer-owned ports.
- `billing/`, `catalog/`, `db/`: billing domain, versioned catalog and Drizzle repositories.
- `providers/`: Apple, Google and Stripe integrations and their capability declarations.
- `workers/`, `projections/`: durable background work and signed HTTP projection delivery.
- `mcp/`: the MCP tools and read-only stdio server, a client of `/v1` through the bundled `sdk/`
  ([docs/mcp.md](docs/mcp.md)).
- `composition/`: wires the modules together, including the remote MCP transport and OpenAPI
  generation.
- `shared/`: module-neutral helpers; `observability/`: logging, metrics and Sentry.

Ordered SQL migrations live in `migrations/` and generated contracts in `contracts/v1/`. Tests
mirror the source layout under `tests/`, merchant database tests live in `integration/merchant/`,
and guarded test entrypoints in `src/testing/`. Every TypeScript file belongs to exactly one
module owner; `bun run check:boundaries` enforces module and table ownership (see
[docs/architecture.md](docs/architecture.md)).

## Architecture

How the runtime fits together, and the repository checks that most often reject a change.

### One process, several HTTP surfaces

- `src/index.ts` -> `src/composition/public-runtime.ts` (`createQuotumRuntime`) ->
  `src/runtime.ts` (`createBillingRuntime`) builds everything: repositories, the provider registry,
  eight polling workers, shutdown hooks, then the "staff" Elysia app from `src/app.ts`
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
  at 1.0. Follow `docs/operations.md` for compatibility and `docs/upgrade-transitions.md` for
  populated-database transitions.
- Unit tests under `tests/db` assert rendered SQL via `tests/helpers/drizzle-sql.ts` without a
  database; real behavior lives in `tests/integration`.

### Workers and projections

`createBillingRuntime` schedules each worker's `runOnce` with `startPollingRuntime`
(`src/workers/runtime.ts`) unless a distribution supplies its own scheduler: projection sync,
store-event replay, subscription reconciliation, metering maintenance, recurring billing, auto
top-up, promotion maintenance, usage partition upkeep (`src/workers/usage-partition-upkeep.ts`,
which adds monthly `usage_events` partitions ahead of time; `quotum partitions` runs it on demand),
plus Stripe App event processing when Apps OAuth is configured.
Workers lease job rows by `worker_id` (`locked_by` columns, refreshed by
`src/workers/lease-heartbeat.ts`) and retry with `src/workers/backoff.ts`, so a worker must only
touch rows it holds. Projection sync delivers signed `billing_state_v1` payloads to each project's
configured projection URL via `src/projections/http-client.ts`, through `postToDestination` in
`src/shared/safe-http.ts`: public HTTPS only, unless a headless deployment approves private
networks (`src/composition/projection-destinations.ts`). Provider credentials and
projection secrets are encrypted, database-owned connections resolved per project by
`RuntimeConnectionResolver`; there is no env-level customer list, and
`BILLING_PROJECT_RUNTIME_JSON` / `BILLING_PROJECTS_JSON` are rejected on purpose.

### MCP

`src/mcp/` holds the read-only tools, remote proposal tools, contract tools and the read-only stdio
entrypoint (`bun run mcp`). Read tools send API requests through `createGuardedFetch`
(`src/mcp/guarded-fetch.ts`), whose `allowedRequests` list remains read-only. The optional
remote transport (`QUOTUM_MCP_ENABLED`, `QUOTUM_MCP_PUBLIC_ORIGIN`) is
`src/composition/remote-mcp.ts`: it serves `/mcp` and the OAuth endpoints in the API process,
verifies grants issued by `src/platform/mcp/`, and dispatches the same guarded requests through
`MerchantBillingPort` (`src/composition/mcp-port-fetch.ts`) without a project key. A new read tool
needs its route in `allowedRequests` (`tests/mcp/inventory.test.ts` pins tools against the
allowlist), a `/v1` route that opts into read-only credentials
(`tests/mcp/contract-allowlist.test.ts`), and a `merchantBillingOperations` entry handled by
`src/composition/merchant-billing.ts` (`tests/mcp/port-fetch.test.ts`). Never add a write to this
allowlist. Remote proposal tools are separately gated by `QUOTUM_MCP_WRITES_ENABLED` (default
false), explicit `quotum.billing.write` consent and current permissions. They use the injected
change port to prepare immutable proposals; execution requires the merchant browser decision
routes and applicable step-up authentication. Deploy matching merchant UI before enabling them.

### Test entrypoints

`src/testing/test-*-entrypoint.ts` start the real runtime with test doubles.
`test-stripe-entrypoint.ts` (`bun run test:stripe-entrypoint`, used by `docs/quickstart.md`) and
`test-merchant-entrypoint.ts` use fake providers, captured mail and in-memory connections from
`BILLING_TEST_CONNECTIONS_JSON`; `test-runtime-entrypoint.ts` is the process the e2e lane spawns,
with loopback projection delivery. Each throws unless `BILLING_ENV=test` plus its matching
`BILLING_TEST_*` / `MERCHANT_TEST_MODE` flags are set; do not loosen those guards.

## Commands

Use Bun `>=1.4.0 <1.5.0`. Docker is required for every Postgres-backed lane.

- `bun install --frozen-lockfile`, then `bun run dev` for a hot-reloading server on `PORT`
  (default 3000). Copy `.env.example` first: merchant authentication and an email sender are
  required outside `BILLING_ENV=test` unless `QUOTUM_MERCHANT_ENABLED=false` runs headless.
  [docs/quickstart.md](docs/quickstart.md) runs a complete local service on the fake Stripe test
  entrypoint.
- `POSTGRES_URI=... bun run migrate` applies the ordered migrations; `bun run migrate:status`
  inspects them.
- `bun run quality` is the CI static gate: boundaries, types, lint and formatting.
  `bun run quality:fix` applies lint and format fixes.
- `bun run test` runs the unit suite (`bun test tests`) without Docker. Run one file with
  `bun test tests/db/meter-limit-windows.test.ts` and filter by test name with `-t "leap-day"`.
- `bun run test:integration`, `bun run test:e2e` and `bun run test:merchant:integration` run the
  Docker-backed lanes. `bun run test:integration <file>` runs a single integration file, including
  one under `integration/merchant/`.
- `bun run openapi:generate`, then `openapi:check` and `openapi:lint`, after changing a route or
  its schemas, adding or renaming an error code, or changing a provider capability declaration
  (`src/providers/*/capabilities.ts`) or the capability vocabulary
  (`src/shared/provider-capabilities.ts`). Commit the regenerated `contracts/v1` files and the
  generated capability table in `docs/providers.md`; `openapi:check` fails CI when any is stale.
- `bun run quotum <command>` runs the operator CLI (`src/cli.ts`, on the image's `PATH` as
  `quotum`): migrations, usage partitions, bootstrap, catalog, connections and credentials, key
  rotation, `healthcheck` and `init`; see [docs/deployment.md](docs/deployment.md#operator-cli).
- `bun run platform:bootstrap`, `catalog:provision` and `catalog` for operator workflows (see
  [docs/quickstart.md](docs/quickstart.md)); `bun run connections:rotate-secrets` re-encrypts
  stored connection secrets with the active key.
- `bun run mcp` starts the read-only stdio MCP server against `QUOTUM_MCP_BASE_URL` with a
  read-only or sandbox `QUOTUM_MCP_API_KEY`; see [docs/mcp.md](docs/mcp.md).
- `bun run test:coverage` runs the unit suite against its local coverage minimum.

## Coding style

Strict TypeScript, small purpose-specific modules, kebab-case file names. Biome formats and lints
everything except the generated `contracts/v1`: tabs, 100-character lines, double quotes,
organized imports. `console` is a lint error; write command output through
`src/shared/cli-output.ts` and diagnostics through the loggers in `src/observability/logger.ts`.
`camelCase` for values and functions, `PascalCase` for types and classes, upper snake case for
environment variables.

## Testing

Tests use `bun:test` and mirror the source layout as `*.test.ts` files. Add focused unit tests for
domain logic, repository contracts, workers, middleware, and environment parsing. CI runs the unit
suite in random order, so a test must not depend on another test's state or order. It gates line
coverage combined across the unit, integration and merchant lanes, with per-area floors in
`coverage-floors.json` and 80% of changed lines; see
[CONTRIBUTING.md](CONTRIBUTING.md#before-you-open-a-pull-request).

Postgres-backed tests under `tests/` are wrapped in `describeLocalPostgres` or `describeE2e` and
skip under plain `bun run test` unless `RUN_POSTGRES_INTEGRATION_TESTS=1` or
`RUN_BILLING_E2E_TESTS=1` is set; `integration/merchant/` is outside the unit suite. Run them
through the lane commands instead: they start a disposable Postgres container, verify migration
checksums, apply migrations and export the `BILLING_TEST_*` settings each lane needs, and they fail
a lane that runs no tests or skips any. Every test must make an assertion, which a preload
enforces, and nothing may be skipped outside those lane gates; see
[CONTRIBUTING.md](CONTRIBUTING.md#coding-conventions). Run `bun run quality` and the relevant test
lane before handing off.

`tests/package-scripts.test.ts` pins the exact text of several package scripts, the lane runners
and Postgres container helper, the assertion preload in `bunfig.toml` and `tests/preload.ts`, the
Dockerfile, and `src/migrate.ts` safety patterns. Changing those requires updating that test
deliberately. `tests/architecture/test-lanes.test.ts` fails on a lane gate outside the directory
its runner covers and on any skip, todo or conditional test modifier.

## Commits and pull requests

Keep Git history linear. Each feature branch must contain one commit before merging: amend
follow-up changes into that commit (`git commit --amend`) and squash any existing intermediate
commits. Rebase onto current `main`; never merge `main` into the branch. After rewriting a
published feature branch, push with `--force-with-lease`. Use squash merge for pull requests;
never create merge commits. Do not rewrite published `main` except for an explicitly authorized
history repair. CI runs on pull requests to any base branch, on merge groups and on
every `main` commit; see [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests) for the merge-queue flow.

Use Conventional Commits with a subject under 72 characters: `feat`, `fix`, `perf`, `refactor`,
`docs`, `test`, `build`, `ci`, `chore` or `revert`, an optional lowercase scope such as `fix(db):`,
and `!` for a breaking change. The pull request title becomes the squash commit and must use the
same form; the `PR title` check enforces it, and merged pull requests are labelled from it for
release notes. Pull requests describe the change, list the verification commands run, call out
migration and environment variable changes with their upgrade order, and include request and
response examples when HTTP behavior changes. A change to a baseline `migrations/*.sql` file must
be named in the `Upgrade notes` section; the `Migration upgrade notes` check enforces it. Release
notes list pull requests by title only, so the description is the detailed record; do not add a
changelog file. Do not bump the `package.json` version in feature pull requests.

## Releases and container publishing

For release work, follow the [publishing checklist](docs/releasing.md#publish-a-container-release).
Keep `package.json` and the committed contract at `0.0.0-dev`; no release branch or version-bump
PR is required. Verify an existing `main` commit, then push the chosen `vX.Y.Z` tag to the GitHub
repository `quotumapp/quotum`. Confirm the tag's `Publish image` run succeeds, GHCR contains
`X.Y.Z` and `X.Y` (plus `latest` for the highest stable version), and the GitHub Release shows the
same image digest and its assets. A package version bump or push to `main` alone does not publish
a versioned image. Check the remote explicitly: a GitLab remote does not trigger publishing.
Publishing runs the shared standalone validation workflow before its publish job; passing release
checks is required before tagging. Published releases are immutable, so fix a bad release with a
new patch. Report a release as published only after verifying the GitHub Release and the
versioned image.

## Security and configuration

Never commit a `.env` file, `POSTGRES_URI`, project or operator credentials, projection secrets,
provider or email-provider credentials, `QUOTUM_AUTH_SECRET`, or the `QUOTUM_SECRETS_KEY_BASE64`
key. Project credentials are issued once by `platform:bootstrap` into an owner-only file; move them
to a secret store and delete the file. Provider and projection settings are encrypted,
database-owned connections managed through the merchant application or, headless, the
`quotum connections` commands; `BILLING_PROJECT_RUNTIME_JSON` and `BILLING_PROJECTS_JSON` are
rejected. Schema files are checksum-verified; before 1.0 they evolve in place and disposable
databases are recreated. Never bypass migration integrity checks or reset populated production data
as a routine upgrade. Treat migrations, bootstrap output, credential handling, and provider webhook
verification as security-sensitive code and add focused tests when changing them.

## Documentation with implementation changes

Review the owning current documentation when changing source, configuration, schemas or commands.
Keep accepted targets distinguishable from implemented behavior. In the multi-repository Quotum
workspace, use the sibling documentation repository's `documentation-context.md` workflow to route
changed paths and check review freshness. Standalone contributions still review their local docs;
they do not require a private sibling checkout. Read original sources before trusting a graph or
an unchanged review checkpoint.
