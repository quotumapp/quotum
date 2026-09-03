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
  your database, and note the change in the changelog. Incremental migrations start at 1.0.
- Keep the Drizzle schema in `src/db/schema.ts` in step with the SQL.
- Call out every schema change and every environment variable change in the pull request description,
  including upgrade order when workers must be drained first.

## Coding conventions

- Strict TypeScript, small purpose-specific modules, kebab-case file names.
- Biome is the formatter and linter: tabs, 100-character lines, double quotes, organized imports.
- Tests use `bun:test` and live under `tests/` mirroring the source layout. Name files `*.test.ts`.
- Treat migrations, bootstrap output, credential handling, and provider webhook verification as
  security-sensitive code and add focused tests for them.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`,
`docs:`, `test:`, `chore:`, `ci:`. Keep the subject under 72 characters and explain the why in the
body when it is not obvious.

## Pull requests

- Describe the change and the verification commands you ran.
- Include request and response examples when HTTP behavior changes.
- Link related issues.
- Keep pull requests focused; unrelated refactors belong in their own change.

## License of contributions

By submitting a contribution you agree that it is licensed under the Apache License 2.0, the same
license that covers this repository, and that you have the right to submit it under those terms.
