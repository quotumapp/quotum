# Architecture and module boundaries

- Document kind: Current behavior

Quotum is one deployable modular service on one Postgres database. Module and table ownership is
enforced by `bun run check:boundaries`, which parses every TypeScript source with the TypeScript
compiler and inspects every ordered SQL migration. Every source file must match exactly one owner;
unclassified or overlapping files and unresolved imports fail the check.

| Owner | Files | May depend on |
| --- | --- | --- |
| Billing | `src/admin`, `src/app`, `src/billing`, `src/catalog`, `src/db`, `src/http`, `src/observability`, `src/operations`, `src/projects`, `src/projections`, `src/providers`, `src/sdk`, `src/workers`, `src/env.ts`, `scripts/billing-catalog.ts` | Billing, shared |
| Platform | `src/platform` | Platform, shared |
| Shared | `src/shared` | Shared |
| Composition | `src/composition`, `src/app.ts`, `src/index.ts`, `src/runtime.ts`, `src/migrate.ts`, `src/platform-bootstrap.ts`, `src/shutdown.ts`, `scripts/provision-catalog.ts` | Everything |
| Test support | `tests`, `src/testing`, scenario runners, `scripts/lib` | Everything |

The policy is deny-by-default:

- Billing and platform never import each other, including through the package's own SDK export.
  Composition wires them through typed ports.
- Shared code cannot depend on either domain, and production modules cannot import composition or
  test-support code.
- Platform and shared code cannot import billing persistence, Drizzle, Postgres clients, or Bun SQL.
  Platform repositories receive a schema-neutral query executor from composition and must pass inline
  static SQL as `executor.query({ text, values })`; computed or concatenated SQL fails the check.
- Platform-owned tables use the `platform_` prefix. Static platform SQL may reference only those
  tables; billing source and billing migrations may not. The single cross-domain SQL exception is
  `src/composition/project-instance-persistence.ts`.
- `001_platform.sql` and `004_merchant.sql` own the platform schema. Every other migration is
  rejected if it touches a `platform_*` table, and dynamic SQL in migrations is denied outside the
  reviewed usage partition block in `003_metering_and_pricing.sql`.

## Source map

- `src/app/`, `src/platform/app.ts`: trusted backend and merchant HTTP surfaces.
- `src/composition/`: module wiring, auth and persistence ports, OpenAPI and connection adapters.
- `src/billing/`, `src/catalog/`, `src/db/`: billing domain, catalog, and persistence.
- `src/platform/`: organizations, identity, onboarding, connections, and audit.
- `src/providers/`, `src/workers/`, `src/projections/`: external providers and durable delivery.
- `migrations/`: ordered schema authority.
- `tests/`: unit, integration, and end-to-end coverage mirroring the source layout.
- `contracts/v1/`: generated OpenAPI contract and error inventory.
