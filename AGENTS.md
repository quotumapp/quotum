# Repository Guidelines

Guidance for contributors and coding agents working in this repository. The longer form lives in
[CONTRIBUTING.md](CONTRIBUTING.md) and the guides under [docs/](docs/).

## Project structure

Bun/TypeScript/Hono billing service backed by one Postgres database. Runtime code lives in `src/`:
`app.ts` and `app/` build the trusted-backend HTTP API; `platform/` owns organizations, identity,
onboarding, connections, and audit behind consumer-owned ports; `billing/`, `catalog/`, and `db/`
hold the billing domain, versioned catalog, and Drizzle repositories; `providers/` integrates Apple,
Google, and Stripe; `workers/` and `projections/` run durable background work and signed HTTP
projection delivery; `composition/` wires modules together. Ordered SQL migrations live in
`migrations/`, generated contracts in `contracts/v1/`, and tests mirror the source layout under
`tests/`, `integration/merchant/`, and `src/testing/`. Module and table ownership is enforced by
`bun run check:boundaries`; see [docs/architecture.md](docs/architecture.md).

## Commands

- `bun install --frozen-lockfile`, then `bun run dev` for a hot-reloading server.
- `POSTGRES_URI=... bun run migrate` and `bun run migrate:status` for schema changes.
- `bun run quality` runs boundaries, types, lint, and formatting; `bun run quality:fix` applies
  lint and format fixes.
- `bun run test` for unit tests; `bun run test:integration`, `bun run test:e2e`, and
  `bun run test:merchant:integration` for the Docker-backed lanes.
- `bun run openapi:generate`, `openapi:check`, and `openapi:lint` after changing any route.
- `bun run platform:bootstrap`, `catalog:provision`, and `catalog` for operator workflows; see
  [docs/quickstart.md](docs/quickstart.md).

## Coding style

Strict TypeScript, small purpose-specific modules, kebab-case file names. Biome formats and lints:
tabs, 100-character lines, double quotes, organized imports. `camelCase` for values and functions,
`PascalCase` for types and classes, upper snake case for environment variables.

## Testing

Tests use `bun:test`. Add focused unit tests for domain logic, repository contracts, workers,
middleware, and environment parsing. Docker-backed integration and end-to-end cases stay skipped
under plain `bun run test` unless `RUN_POSTGRES_INTEGRATION_TESTS=1` or `RUN_BILLING_E2E_TESTS=1`
is set; run the dedicated commands instead. Run `bun run quality` and the relevant test lane before
handing off.

## Commits and pull requests

Use Conventional Commits with a subject under 72 characters. Pull requests describe the change,
list the verification commands run, call out migration and environment variable changes with their
upgrade order, and include request and response examples when HTTP behavior changes.

## Releases and container publishing

For release work, follow the [publishing checklist](docs/operations.md#publish-a-container-release).
Update `package.json` and `CHANGELOG.md`, verify the release commit, then push its matching
`vX.Y.Z` tag to the GitHub repository `quotumapp/quotum`. Confirm the tag's `Publish image` run
succeeds and GHCR contains `X.Y.Z`, `X.Y`, and `latest`; record the image digest. A package version
bump or push to `main` alone does not publish a versioned image. Check the remote explicitly:
`origin` may point to GitLab. Publishing runs independently of CI, so passing release checks is
required before tagging. Report a release as published only after verifying the versioned image.

## Security and configuration

Never commit `POSTGRES_URI`, project credentials, projection secrets, provider credentials, or the
`QUOTUM_SECRETS_KEY_BASE64` key. Schema files are checksum-verified; before 1.0 they evolve in place and databases are recreated. Project
credentials are issued once by `platform:bootstrap` into an owner-only file; move them to a secret
store and delete the file. Provider and projection settings are encrypted, database-owned
connections managed through the merchant application; `BILLING_PROJECT_RUNTIME_JSON` and
`BILLING_PROJECTS_JSON` are rejected. Treat migrations, bootstrap output, credential handling, and
provider webhook verification as security-sensitive code.

## Documentation with implementation changes

Review the owning current documentation when changing source, configuration, schemas or commands.
Keep accepted targets distinguishable from implemented behavior. In the multi-repository Quotum
workspace, use the sibling documentation repository's `documentation-context.md` workflow to route
changed paths and check review freshness. Standalone contributions still review their local docs;
they do not require a private sibling checkout. Read original sources before trusting a graph or
an unchanged review checkpoint.
