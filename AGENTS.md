# Repository Guidelines

## Project Structure & Module Organization

This is a Bun/TypeScript billing service. Runtime code lives in `src/`: `app.ts` and `app/` build
the Hono API; `index.ts` and `runtime.ts` start the service and its six polling runtimes; `env.ts`
validates configuration; `billing/` contains domain logic; `catalog/` owns versioned publication;
`db/` contains the Drizzle/Postgres client and repository domains; `workers/` contains projection,
provider-replay, reconciliation, metering-maintenance, recurring-billing, and automatic-top-up workers;
and `projections/` contains HTTP projection delivery. Tests live in `tests/` and mirror the source
areas, with real-Postgres journeys under `tests/integration/` and process-level journeys under
`tests/e2e/`. Database schema changes belong in ordered files under `migrations/`.

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run dev`: run `src/index.ts` with Bun hot reload.
- `POSTGRES_URI=... bun run migrate`: apply pending SQL migrations from `migrations/`.
- `POSTGRES_URI=... bun run migrate:status`: inspect migration status and checksums.
- `bun run test`: run the Bun test suite under `tests/`.
- `bun run test:integration`: run Docker-backed Postgres integration tests under `tests/integration/`.
- `bun run test:e2e`: run black-box E2E tests that boot the real service process.
- `bun run typecheck`: run TypeScript with `tsc --noEmit`.
- `bun run lint`: run Biome checks.
- `bun run format:check`: verify Biome formatting.
- `bun run quality`: run typecheck, lint, and format checks together.

Apply the current schema with `POSTGRES_URI=... bun run migrate`. Do not add external database API,
RLS, role-grant, or stored-procedure assumptions back into this service.

## Coding Style & Naming Conventions

Use strict TypeScript and keep modules small and purpose-specific. Biome is the formatter and linter: tabs for indentation, 100-character line width, double quotes in JavaScript/TypeScript, and organized imports. Use `camelCase` for variables and functions, `PascalCase` for classes and types, and uppercase snake case for environment variables. Existing filenames use kebab case, such as `projection-sync.ts` and `api-key.ts`; follow that pattern for new files.

## Testing Guidelines

Tests use `bun:test` with `describe`, `it`, and `expect`. Name test files `*.test.ts` and place them
in the matching `tests/` subdirectory. Add focused unit tests for domain logic, repository
transaction contracts, workers, middleware, and environment parsing. Run
`bun run test:integration` for real-Postgres catalog, metering, provider, controls, concurrency,
worker, idempotency, and projection journeys; those Docker-backed tests remain skipped under plain
`bun run test` unless `RUN_POSTGRES_INTEGRATION_TESTS=1` is set. Run `bun run test:e2e` for
black-box service-process coverage under `tests/e2e`; the runner starts Docker Postgres, applies
migrations, boots `src/index.ts`, and gates those tests with `RUN_BILLING_E2E_TESTS=1`. Run
`bun run test` for behavior changes and `bun run quality` before handing off.

## Commit & Pull Request Guidelines

The current history is minimal and uses a concise imperative subject, for example `Initial billing service`. Keep future commit subjects short and action-oriented. Pull requests should describe the change, list verification commands run, call out migration or environment variable changes, and link related issues or tasks. Include request/response examples when changing HTTP behavior.

## Security & Configuration Tips

Never commit `POSTGRES_URI`, project API keys, projection secrets, provider credentials, or
production database URLs. Billing never writes product app databases directly; configure project
`projectionUrl` and `projectionSecret` values through `BILLING_PROJECTS_JSON` when exercising
projection delivery. Treat SQL migrations and provider webhook handling as security-sensitive code.
