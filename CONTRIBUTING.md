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
the module boundary checker where present. Use `bun run quality:fix` to apply lint and formatting
fixes.

Run the Postgres-backed suites when you touch billing behavior, repositories, SQL, workers, or
provider integrations:

```sh
bun run test:integration
bun run test:e2e
```

Both runners start their own Docker Postgres, apply migrations, and remove the container when
they finish.

## Migrations

- SQL files under `migrations/` are the source of truth and are checksum-verified by the migration
  runner. Before 1.0 they are baseline files that evolve in place: edit the domain file, recreate
  your database, and describe the change in the pull request. Incremental migrations start at 1.0.
- Keep the Drizzle schema in `src/db/schema.ts` in step with the SQL.
- Call out every schema change and every environment variable change in the pull request description,
  including upgrade order when workers must be drained first.

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

## Coding conventions

- Strict TypeScript, small purpose-specific modules, kebab-case file names.
- Biome is the formatter and linter: tabs, 100-character lines, double quotes, organized imports.
- Tests use `bun:test` and live under `tests/` mirroring the source layout. Name files `*.test.ts`.
- Treat migrations, bootstrap output, credential handling, and provider webhook verification as
  security-sensitive code and add focused tests for them.
- Bind JSON parameters as text and cast on the server: use the `jsonb()` helper or
  `${JSON.stringify(value)}::text::jsonb`. A bare `::jsonb` cast on a string parameter is encoded
  twice under prepared statements, and a raw object parameter fails without them.
- Inside a transaction, statements that depend only on values already in hand may be issued
  together with `Promise.all`; they execute in issue order on the connection, so put writes before
  the reads that must observe them, and never feed one statement's result into another in the
  same batch.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`,
`refactor:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `revert:`, with an optional lowercase scope
such as `fix(db):`. Mark breaking changes with `!`, for example `feat!:`. Keep the subject under 72
characters and explain the why in the body when it is not obvious.

## Pull requests

Push your feature or fix branch to GitHub and open a draft pull request targeting `main` early
to get CI feedback. Pushing a branch without an open pull request does not trigger
[GitHub CI](.github/workflows/ci.yml). Opening a pull request, including a draft, triggers CI;
subsequent pushes to that pull request's branch rerun it. CI also runs after commits land on `main`.

Pull requests run the shared [standalone validation](.github/workflows/validate.yml): static
checks, unit tests and coverage, OpenAPI checks, Postgres integration tests, end-to-end tests,
merchant integration tests, and a container build. They also run a bundle size check and an
advisory dependency audit. Fix failing checks and wait for all required checks to pass on the
latest revision before merging; a successful branch push alone is not validation. The release
pull request follows the same process, and release tagging additionally requires successful CI
on the exact merged `main` commit as described in the publishing checklist.

Keep history linear and prepare one commit per feature branch before merging. Fold follow-up
changes into the branch commit with `git commit --amend`; squash intermediate commits with an
interactive rebase when needed. Rebase the branch onto current `main` instead of merging `main`
into it. Update a previously pushed branch with `git push --force-with-lease`. Run the required
checks on the final amended commit, then use GitHub **Squash and merge**. Merge commits and
rebase-merging multiple branch commits are not part of this workflow. Published `main` must not
be rewritten without explicit authorization for a history repair.

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
