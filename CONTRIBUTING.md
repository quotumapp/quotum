# Contributing

Thank you for helping improve the Quotum Billing API. This document explains how to set up a
development environment, what checks a change must pass, and how to submit it.

## Development setup

- Install Bun 1.4.x (`>=1.4.0 <1.5.0`) and Docker. Docker is required for the integration and
  end-to-end suites, which start disposable Postgres containers.
- Run `bun install` in the repository root.
- Follow the README quickstart to run the service against a local Postgres.

## Before you open a pull request

Run the static checks and the unit tests:

```sh
bun run quality
bun run test
```

`bun run quality` runs the repository's static checks: TypeScript, Biome lint and formatting, and
the module boundary checker. Use `bun run quality:fix` to apply lint and formatting fixes.

Run the Postgres-backed suites when you touch billing behavior, repositories, SQL, workers, or
provider integrations:

```sh
bun run test:integration
bun run test:e2e
```

Both runners start their own Docker Postgres, apply migrations, and remove the container when
they finish.

CI gates combined line coverage. It merges the LCOV reports of the unit lane, both integration
shards and the merchant lane: for each file it keeps the lines every report containing that file
lists, with the highest hit count, and counts a tracked runtime module that no report loads as
uncovered (type-only files and `src/testing/` are excluded). `coverage-floors.json` sets floors
for the total and for `src/billing/`, `src/db/repository/`, `src/providers/`, `src/platform/` and
`src/http/`; a floor must stay within two percentage points of actual coverage, so after reviewing
a change regenerate it with `bun scripts/check-coverage.ts --write <unit-lcov> <integration-1-lcov>
<integration-2-lcov> <merchant-lcov>`. Pull requests and merge groups also need 80% of their
changed executable lines covered. `bun run test:coverage` stays a fast unit-only check with its own
line and function floor.

Set `QUOTUM_TEST_REPORT_DIR` to keep a Docker lane's `junit.xml` after it passes or fails; use a
separate directory for concurrent lanes or shards. CI uploads `junit-integration-1`,
`junit-integration-2`, `junit-merchant` and `junit-e2e` for 30 days, including failed runs that
produced a report. Empty or skipped lanes still fail. Without the variable the runners delete their
temporary report as before; credential directories are always removed.

## Migrations

- SQL files under `migrations/` are the source of truth and are checksum-verified by the migration
  runner. Before 1.0 they are baseline files that evolve in place: edit the domain file, recreate
  your database, and describe the change in the pull request. Incremental migrations start at 1.0.
- The integration lane compares every billing table in `src/db/schema.ts` with the migrated
  Postgres catalog (`tests/integration/schema-parity.test.ts`): columns, primary/unique/foreign
  keys and delete actions, named indexes with column order, direction and predicates, and CHECK
  names. Keep the mirror in step with SQL. There are no CHECK exceptions; do not add new
  exclusions. Partition children and migration bookkeeping are excluded. The platform-owned
  project foreign key is asserted explicitly at the test's composition boundary so billing
  declares no platform table.
- Call out every schema change and every environment variable change in the pull request description,
  including upgrade order when workers must be drained first.
- A pull request that changes a baseline `migrations/*.sql` file must name every changed file in
  its `Upgrade notes` section and describe the operator action; the `Migration upgrade notes`
  check rejects a missing section, `None`, or an unnamed file. The release `meta` and `unreleased`
  commands list baseline changes since the previous tag; `meta` warns for a patch release, and
  `unreleased` warns when `NEXT_VERSION` is set.

## HTTP contract

Every route is described by an authored Zod response schema and registered directly on the Elysia
app with `operationDetail` metadata (`operationId`, `tags`, `responses`). Request bodies, query
and path parameters are documented from the route's Elysia validators, or from
`operationDetail({ request })` when the handler validates input itself. When you add or change an
operation, update its schema and regenerate the committed OpenAPI artifacts:

```sh
bun run openapi:generate
bun run openapi:check
bun run openapi:lint
```

CI diffs `contracts/v1/openapi.json` against the base branch; a compatible patch release must not
introduce breaking changes.

`openapi:generate` writes `contracts/v1/openapi.json`, the error inventory
`contracts/v1/errors.json` and the provider capability contract
`contracts/v1/provider-capabilities.json`, and rewrites the generated capability table in
[`docs/providers.md`](docs/providers.md#provider-capabilities). `openapi:check` fails when any of
them is stale. Change provider support in the declarations under `src/providers/`, never in the
generated files.

## Coding conventions

- Strict TypeScript, small purpose-specific modules, kebab-case file names.
- Biome is the formatter and linter: tabs, 100-character lines, double quotes, organized imports.
- Tests use `bun:test` and live under `tests/` mirroring the source layout. Name files `*.test.ts`.
- Every test must make at least one assertion: `tests/preload.ts` calls `expect.hasAssertions()`
  before each test in every lane. Assert the outcome itself rather than guarding an `expect` with
  a condition that may never hold, and give `toThrow` or `rejects` the error code or message.
- Do not skip tests. Postgres and end-to-end suites are gated with `describeLocalPostgres` or
  `describeE2e` inside the directories their lane runs (`tests/integration`, `integration/merchant`,
  `tests/e2e`), and those runners fail on any skip. `tests/architecture/test-lanes.test.ts` rejects
  a gate anywhere else and any other skip, todo or conditional modifier; Biome rejects `.skip` and
  `.only`.
- Bun's `toMatchObject` writes asymmetric matchers such as `expect.any(String)` into the received
  object. Match a `structuredClone` when the value is compared again later.
- Treat migrations, bootstrap output, credential handling, and provider webhook verification as
  security-sensitive code and add focused tests for them.
- Bind JSON parameters as text and cast on the server: use the `jsonb()` helper or
  `${JSON.stringify(value)}::text::jsonb`. A bare `::jsonb` cast on a string parameter is encoded
  twice under prepared statements, and a raw object parameter fails without them.
- Inside a transaction, statements that depend only on values already in hand may be issued
  together with `Promise.all`; they execute in issue order on the connection, so put writes before
  the reads that must observe them, and never feed one statement's result into another in the
  same batch.
- Stripe test fixtures are written in the pinned API version's shape and checked with
  `satisfies DeepPartial<Stripe.X>` (`tests/helpers/deep-partial.ts`), so a field the version
  does not have fails to compile. Older shapes the normalizer still accepts belong in
  `legacy`-named fixtures in its unit tests. The Stripe fakes reject an idempotency key reused
  for a different request, as Stripe does.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`,
`refactor:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `revert:`, with an optional lowercase scope
such as `fix(db):`. Mark breaking changes with `!`, for example `feat!:`. Keep the subject under 72
characters and explain the why in the body when it is not obvious.

## Pull requests

Push your feature or fix branch to GitHub and open a draft pull request early to get CI
feedback. Pushing a branch without an open pull request does not trigger
[GitHub CI](.github/workflows/ci.yml). Opening a pull request against any base branch, including a
draft or a pull request stacked on another branch, triggers CI; subsequent pushes to that pull
request's branch rerun it and cancel the superseded run. CI also runs on merge groups and on every
commit that lands on `main`, and each `main` commit keeps its own run.

Pull requests run the shared [standalone validation](.github/workflows/validate.yml): static
checks, unit tests and coverage, OpenAPI checks, Postgres integration tests, end-to-end tests,
merchant integration tests, and a container build. They also run a bundle size check and an
advisory dependency audit. Fix failing checks and wait for all required checks to pass on the
latest revision before merging; a successful branch push alone is not validation. Release
tagging requires successful CI on the exact `main` commit being tagged, as described in the
publishing checklist.

Keep history linear and prepare one commit per feature branch before merging. Fold follow-up
changes into the branch commit with `git commit --amend`; squash intermediate commits with an
interactive rebase when needed. Rebase the branch onto current `main` instead of merging `main`
into it. Update a previously pushed branch with `git push --force-with-lease`. Run the required
checks on the final amended commit, then use GitHub **Squash and merge**. Merge commits and
rebase-merging multiple branch commits are not part of this workflow. Published `main` must not
be rewritten without explicit authorization for a history repair. Once the repository merge queue is
enabled, enqueue with `gh pr merge --squash --auto --match-head-commit <sha>` after rebasing and
validating the current head; enabling the queue is a separate repository setting change.

The pull request title becomes the squash commit on `main`, so it must be a Conventional Commit
subject under 72 characters; the `PR title` check fails otherwise. After merge, the pull request is
labelled from its title for the grouped GitHub Release notes: `feat` becomes `feature`, `fix` becomes
`bug`, `perf` becomes `performance`, `docs` becomes `documentation`, other types become
`maintenance`, `!` adds `breaking`, and `chore(release):` gets `ignore-for-release`. Maintainers add
`security` by hand for security fixes and `ignore-for-release` for other changes that should not
appear in release notes.

Release notes list pull requests by title only, so the pull request description is the detailed
record of a change. Do not bump the `package.json` version in feature pull requests; the version
stays at `0.0.0-dev`. Release versions come from Git tags.

- Describe the change and the verification commands you ran.
- For breaking changes, schema or environment changes, write the upgrade notes operators need:
  what changes, what to configure, and the upgrade order.
- Include request and response examples when HTTP behavior changes.
- Link related issues.
- Keep pull requests focused; unrelated refactors belong in their own change.

## Publishing a release

Follow the [container release checklist](docs/operations.md#publish-a-container-release) for the
verification, the GitHub tag push, and confirmation of the GHCR image. Tag an existing verified
`main` commit; no release branch or version-bump PR is required. Pushing `main` publishes only
the rolling `main` image. The tag's workflow publishes
the image and then the GitHub Release.

## License of contributions

By submitting a contribution you agree that it is licensed under the Apache License 2.0, the same
license that covers this repository, and that you have the right to submit it under those terms.
