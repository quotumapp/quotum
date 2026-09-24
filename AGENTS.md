# Repository Guidelines

Guidance for contributors and coding agents working in this repository. The longer form lives in
[CONTRIBUTING.md](CONTRIBUTING.md) and the guides under [docs/](docs/), which describe current
behavior; update the owning guide in place instead of restating it here.

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
- `mcp/`: the read-only MCP tools and stdio server, a client of `/v1` through the bundled `sdk/`
  ([docs/mcp.md](docs/mcp.md)).
- `composition/`: wires the modules together, including the remote MCP transport and OpenAPI
  generation.
- `shared/`: module-neutral helpers; `observability/`: logging, metrics and Sentry.

Ordered SQL migrations live in `migrations/` and generated contracts in `contracts/v1/`. Tests
mirror the source layout under `tests/`, merchant database tests live in `integration/merchant/`,
and guarded test entrypoints in `src/testing/`. Every TypeScript file belongs to exactly one
module owner; `bun run check:boundaries` enforces module and table ownership (see
[docs/architecture.md](docs/architecture.md)).

## Commands

Use Bun `>=1.4.0 <1.5.0`. Docker is required for every Postgres-backed lane.

- `bun install --frozen-lockfile`, then `bun run dev` for a hot-reloading server on `PORT`
  (default 3000). Copy `.env.example` first: merchant authentication and an email sender are
  required outside `BILLING_ENV=test`. [docs/quickstart.md](docs/quickstart.md) runs a complete
  local service on the fake Stripe test entrypoint.
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
- `bun run platform:bootstrap`, `catalog:provision` and `catalog` for operator workflows (see
  [docs/quickstart.md](docs/quickstart.md)); `bun run connections:rotate-secrets` re-encrypts
  stored connection secrets with the active key.
- `bun run mcp` starts the read-only stdio MCP server against `QUOTUM_MCP_BASE_URL` with a
  read-only or sandbox `QUOTUM_MCP_API_KEY`; see [docs/mcp.md](docs/mcp.md).
- `bun run test:coverage` runs the unit suite against CI's coverage minimum.

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
suite in random order and enforces minimum line and function coverage, so a test must not depend
on another test's state or order.

Postgres-backed tests under `tests/` are wrapped in `describeLocalPostgres` or `describeE2e` and
skip under plain `bun run test` unless `RUN_POSTGRES_INTEGRATION_TESTS=1` or
`RUN_BILLING_E2E_TESTS=1` is set; `integration/merchant/` is outside the unit suite. Run them
through the lane commands instead: they start a disposable Postgres container, verify migration
checksums, apply migrations and export the `BILLING_TEST_*` settings each lane needs, and they fail
a lane that runs no tests or skips any. Run `bun run quality` and the relevant test lane before
handing off.

## Commits and pull requests

Keep Git history linear. Each feature branch must contain one commit before merging: amend
follow-up changes into that commit (`git commit --amend`) and squash any existing intermediate
commits. Rebase onto current `main`; never merge `main` into the branch. After rewriting a
published feature branch, push with `--force-with-lease`. Use squash merge for pull requests;
never create merge commits. Do not rewrite published `main` except for an explicitly authorized
history repair.

Use Conventional Commits with a subject under 72 characters: `feat`, `fix`, `perf`, `refactor`,
`docs`, `test`, `build`, `ci`, `chore` or `revert`, an optional lowercase scope such as `fix(db):`,
and `!` for a breaking change. The pull request title becomes the squash commit and must use the
same form; the `PR title` check enforces it, and merged pull requests are labelled from it for
release notes. Pull requests describe the change, list the verification commands run, call out
migration and environment variable changes with their upgrade order, and include request and
response examples when HTTP behavior changes. Release notes list pull requests by title only, so
the description is the detailed record; `CHANGELOG.md` is frozen at 0.10.1 and takes no new
entries. Do not bump the `package.json` version in feature pull requests.

## Releases and container publishing

For release work, follow the [publishing checklist](docs/operations.md#publish-a-container-release).
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
database-owned connections managed through the merchant application;
`BILLING_PROJECT_RUNTIME_JSON` and `BILLING_PROJECTS_JSON` are rejected. Schema files are
checksum-verified; before 1.0 they evolve in place and disposable databases are recreated. Never
bypass migration integrity checks or reset populated production data as a routine upgrade. Treat
migrations, bootstrap output, credential handling, and provider webhook verification as
security-sensitive code and add focused tests when changing them.

## Documentation with implementation changes

Review the owning current documentation when changing source, configuration, schemas or commands.
Keep accepted targets distinguishable from implemented behavior. In the multi-repository Quotum
workspace, use the sibling documentation repository's `documentation-context.md` workflow to route
changed paths and check review freshness. Standalone contributions still review their local docs;
they do not require a private sibling checkout. Read original sources before trusting a graph or
an unchanged review checkpoint.
