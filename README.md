# Quotum API

Bun/TypeScript/Hono billing API with PostgreSQL, merchant administration and background workers.
Billing owns its ledger, catalog, customers, subscriptions, provider events and durable operations.
Product backends call authenticated APIs and consume signed projections into their own read models;
they do not access Quotum's tables directly.

The current app uses web onboarding and encrypted database-owned integrations. No deployment-level
customer list is required. The operator UI is the sibling `quotum-ui` application.

## Read first

- [Quickstart](docs/quickstart.md): local Postgres, migrations, bootstrap, catalog, a synthetic
  purchase, and metered usage in five minutes.
- [Deployment and configuration](docs/deployment.md): container image, required and optional
  variables, authentication modes, test entrypoints. See [`.env.example`](.env.example).
- [Provider integrations](docs/providers.md): Apple, Google, Stripe, and signed projections.
- [API guide](docs/api.md): metering, recovery, catalog publication, admin operations.
- [Operations](docs/operations.md): backup, restore, upgrade, rollback, workers, support policy.
- [Architecture](docs/architecture.md): module boundaries and source map.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md).

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

Merchant authentication is always on and requires an explicitly selected Cloudflare or Resend
email sender outside `BILLING_ENV=test`; copy `.env.example` before `bun run dev`. The operator owns
the `QUOTUM_AUTH_SECRET` and `QUOTUM_EMAIL_*` settings. The fake test entrypoints are not
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
| Apply / inspect migrations | `bun run migrate`, `bun run migrate:status` |
| Optional exact-topology bootstrap | `bun run platform:bootstrap -- --check` or `--apply --credentials-out <new-file>` |
| Development catalog import | `bun run catalog:provision` |
| Catalog automation | `bun run catalog status`, `bun run catalog diff <file>`, `bun run catalog push <file>` |
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
- `migrations/`: ordered schema authority; `tests/`: mirrored unit/integration/E2E coverage.

Current requirements live in the guides under [docs/](docs/). Update them in place with behavior
changes, regenerate contracts when structures change, and record exact verification evidence. Do not append a second
feature-status list or copy obsolete setup from Git history into this README.
