# Quotum API

Bun/TypeScript/Elysia billing API with PostgreSQL, merchant administration and background workers.
Billing owns its ledger, catalog, customers, subscriptions, provider events and durable operations.
Product backends call authenticated APIs and consume signed projections into their own read models;
they do not access Quotum's tables directly.

Integrations are encrypted and owned by the database, so no deployment-level customer list is
required. Run Quotum headless and operate it with the `quotum` CLI, as the
[self-hosting guide](docs/self-hosting.md) describes. To give merchants a web interface, build one
on the merchant platform under `/api` (organizations, onboarding and integrations), served through
your own [merchant proxy](docs/deployment.md#merchant-proxy-service-principal). The
[HTTP contract](contracts/v1/openapi.json) documents every route.

## Read first

- [Quickstart](docs/quickstart.md): local Postgres, migrations, bootstrap, catalog, a synthetic
  purchase, and metered usage in five minutes.
- [Self-hosting](docs/self-hosting.md): run Quotum headless with Docker Compose, from secrets to a
  published catalog, then operate and upgrade it.
- [Deployment and configuration](docs/deployment.md): container image, required and optional
  variables, authentication modes, test entrypoints. See [`.env.example`](.env.example).
- [Provider integrations](docs/providers.md): Apple, Google, Stripe, and signed projections.
- [API guide](docs/api.md): metering, recovery, catalog publication, admin operations.
- [Operations](docs/operations.md): backup, restore, upgrade, rollback, workers, support policy.
- [MCP server](docs/mcp.md): read-only browser authorization or stdio access for coding agents.
- [Architecture](docs/architecture.md): module boundaries and source map.
- [Releases](https://github.com/quotumapp/quotum/releases), [SECURITY.md](SECURITY.md),
  [CONTRIBUTING.md](CONTRIBUTING.md).

[contracts/v1/openapi.json](contracts/v1/openapi.json) owns implemented HTTP structures;
[contracts/v1/errors.json](contracts/v1/errors.json) lists known errors. The public `@quotum/sdk`,
separate `@quotum/cli` and replacement usage contract remain a target,
not a published compatibility promise. The bundled `src/sdk` client and catalog script exist today.

## Development

Use Bun from [package.json](package.json) and PostgreSQL. Follow the [quickstart](docs/quickstart.md)
for a complete local run, or:

```sh
bun install --frozen-lockfile
bun run migrate
bun run dev
```

The merchant platform is on by default. Its authentication is always on and requires an explicitly
selected Cloudflare or Resend email sender outside `BILLING_ENV=test`; copy `.env.example` before
`bun run dev`. The operator owns the `QUOTUM_AUTH_SECRET` and `QUOTUM_EMAIL_*` settings.
`QUOTUM_MERCHANT_ENABLED=false` runs [headless](docs/deployment.md#headless-mode): `/v1` and workers
only, with none of those settings. [`deploy/compose`](docs/deployment.md#headless-docker-compose)
runs it with Postgres in Docker Compose. The fake test entrypoints are not
production configurations. `/ready` checks database/schema health;
customer integrations and production activation have separate checks.

## Commands

| Purpose | Command |
| --- | --- |
| Static quality and boundaries | `bun run quality` |
| Unit suite | `bun run test` |
| Disposable PostgreSQL integration | `bun run test:integration` |
| Service-process E2E | `bun run test:e2e` |
| Merchant database integration | `bun run test:merchant:integration` |
| Generate / check / lint HTTP artifacts | `bun run openapi:generate`, `bun run openapi:check`, `bun run openapi:lint` |
| Operator CLI (also on the image's `PATH` as `quotum`) | `bun run quotum help` |
| Apply / inspect migrations | `bun run migrate`, `bun run migrate:status` |
| Optional declarative topology bootstrap | `bun run platform:bootstrap -- --check` or `--apply --credentials-out <new-file>` |
| Development catalog import | `bun run catalog:provision` |
| Catalog automation | `bun run catalog status`, `bun run catalog diff <file>`, `bun run catalog push <file>` |
| Read-only MCP server (stdio, read-only or sandbox key) | `bun run mcp` |
| Connection encryption-key rotation | `bun run connections:rotate-secrets` |

Database/process lanes require Docker and are not implied by a plain unit-test pass. Browser
integration is owned by the separate quotum-autotests project. Follow
[docs/operations.md](docs/operations.md) for upgrade, credentials, catalog, worker recovery, metrics
and rollback. Before 1.0 the schema files under `migrations/` evolve in place and are checksum-verified; recreate
a database from them rather than migrating it.

## Source map

- `src/app/`, `src/platform/app.ts`: trusted backend and merchant HTTP surfaces.
- `src/composition/`: module wiring, auth/persistence ports, OpenAPI and connection adapters.
- `src/billing/`, `src/catalog/`, `src/db/`: billing domain, catalog and persistence.
- `src/platform/`: organization, identity, onboarding, connections and audit.
- `src/providers/`, `src/workers/`, `src/projections/`: external providers and durable delivery.
- `src/mcp/`: read-only MCP tools and stdio server; the remote transport is
  `src/composition/remote-mcp.ts`, with browser authorization in `src/platform/mcp/`.
- `migrations/`: ordered schema authority; `tests/`: mirrored unit/integration/E2E coverage.

Current requirements live in the guides under [docs/](docs/). Update them in place with behavior
changes, regenerate contracts when structures change, and record exact verification evidence. Do not append a second
feature-status list or copy obsolete setup from Git history into this README.
