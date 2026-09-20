# Repository Guidelines

Guidance for contributors and coding agents working in this repository. The longer form lives in
[CONTRIBUTING.md](CONTRIBUTING.md) and the guides under [docs/](docs/).

## Project structure

Bun/TypeScript/Elysia billing service backed by one Postgres database. Runtime code lives in `src/`:
`app.ts` and `app/` build the trusted-backend HTTP API; `platform/` owns organizations, identity,
onboarding, connections, and audit behind consumer-owned ports; `billing/`, `catalog/`, and `db/`
hold the billing domain, versioned catalog, and Drizzle repositories; `providers/` integrates Apple,
Google, and Stripe; `workers/` and `projections/` run durable background work and signed HTTP
projection delivery; `mcp/` is the read-only stdio MCP server, a client of `/v1` through `sdk/`
([docs/mcp.md](docs/mcp.md)); `composition/` wires modules together. Ordered SQL migrations live in
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
- `bun run openapi:generate`, `openapi:check`, and `openapi:lint` after changing any route, a
  provider capability declaration (`src/providers/*/capabilities.ts`), or the capability
  vocabulary (`src/shared/provider-capabilities.ts`).
- `bun run platform:bootstrap`, `catalog:provision`, and `catalog` for operator workflows; see
  [docs/quickstart.md](docs/quickstart.md).
- `bun run mcp` starts the read-only stdio MCP server against `QUOTUM_MCP_BASE_URL` with a sandbox
  `QUOTUM_MCP_API_KEY`; see [docs/mcp.md](docs/mcp.md).

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

Keep Git history linear. Each feature branch must contain one commit before merging: amend
follow-up changes into that commit (`git commit --amend`) and squash any existing intermediate
commits. Rebase onto current `main`; never merge `main` into the branch. After rewriting a
published feature branch, push with `--force-with-lease`. Use squash merge for pull requests;
never create merge commits. Do not rewrite published `main` except for an explicitly authorized
history repair.

Use Conventional Commits with a subject under 72 characters. The pull request title becomes the
squash commit and must use the same form; the `PR title` check enforces it, and merged pull requests
are labelled from it for release notes. Pull requests describe the change,
list the verification commands run, call out migration and environment variable changes with their
upgrade order, and include request and response examples when HTTP behavior changes. Release notes
list pull requests by title only, so the description is the detailed record. Do not bump the
`package.json` version in feature pull requests.

## Releases and container publishing

For release work, follow the [publishing checklist](docs/operations.md#publish-a-container-release).
Keep `package.json` and the committed contract at `0.0.0-dev`; no release branch or version-bump
PR is required. Verify an existing `main` commit, then push the chosen `vX.Y.Z` tag to the GitHub repository `quotumapp/quotum`. Confirm the tag's
`Publish image` run succeeds, GHCR contains `X.Y.Z` and `X.Y` (plus `latest` for the highest stable
version), and the GitHub Release shows the same image digest and its assets. A package version bump
or push to `main` alone does not publish a versioned image. Check the remote explicitly: a GitLab
remote does not trigger publishing. Publishing runs the shared standalone validation workflow before
its publish job; passing release checks is required before tagging. Published releases are immutable,
so fix a bad release with a new patch. Report a release as published only after verifying the GitHub
Release and the versioned image.

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
