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
| MCP | `src/mcp` | MCP, shared, and `src/sdk` only |
| Composition | `src/composition`, `src/app.ts`, `src/index.ts`, `src/runtime.ts`, `src/migrate.ts`, `src/platform-bootstrap.ts`, `src/shutdown.ts`, `scripts/provision-catalog.ts` | Everything |
| Test support | `tests`, `src/testing`, scenario runners, release tooling (`scripts/release.ts`), `scripts/lib` | Everything |

The policy is deny-by-default:

- Billing and platform never import each other, including through the package's own SDK export.
  Composition wires them through typed ports.
- Shared code cannot depend on either domain, and production modules cannot import composition or
  test-support code.
- The MCP server is an HTTP client of the billing API. Its only billing import is the SDK in
  `src/sdk`, no domain module may import it, and it is held to the same persistence ban as platform
  and shared code.
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
  Each provider declares its operation support in `src/providers/<provider>/capabilities.ts`,
  collected by `src/providers/capabilities.ts`. The runtime builds one provider registry
  (`src/providers/registry.ts`) and shares it between request handlers, merchant billing and the
  workers. The registry resolves provider services and builds the `ProviderAdapter` wrappers
  defined in `src/providers/contract.ts`, checked against each declaration. Subscription changes,
  usage invoice periods and auto top-up jobs store their provider and provider account, copied
  from the subscription or provider customer they bill, never from the live connection.
  `src/composition/worker-providers.ts` selects each job's adapter by that stored provider and
  resolves connections for recovery, so queued work still drains after a connection stops
  accepting new work. Immediate subscription changes use the database clock for their effective
  time and worker claims, so application clock skew cannot delay the first claim. Explicit
  `period_end` changes retain the stored subscription period end. Stripe App events are handled
  outside the registry.
- `src/mcp/`: shared read-only [MCP tools and stdio server](mcp.md), a client of `/v1` through
  `src/sdk/`. The optional remote transport in `composition/remote-mcp.ts` dispatches the same
  guarded SDK requests through `MerchantBillingPort`; `platform/mcp/` owns browser authorization,
  immutable grants and live access checks. The tools never import platform or database code.
- `migrations/`: ordered schema authority.
- `tests/`: unit, integration, and end-to-end coverage mirroring the source layout.
- `contracts/v1/`: generated OpenAPI contract, error inventory and provider capability declarations.

## Distributions and public runtime interfaces

GitHub `quotumapp/quotum` owns the public core: billing, generic merchant functionality, providers,
SQL migrations, worker business logic, tests and standalone documentation. A hosted distribution
consumes an unchanged public commit. Hosted composition, routing/fencing policy, tenant migration
coordination and infrastructure scheduler integration belong to that distribution. Reusable fixes
and required extension interfaces are implemented here first.

`quotum-api/runtime` exports `loadQuotumRuntimeConfig()`, `createQuotumRuntime(config, options?)`,
`registerQuotumProcessShutdown(runtime)` and their types. The runtime exposes `app.fetch`, `start()`
and `stop()`. `app.fetch(request, server)` takes Bun's server as its optional second argument;
a distribution that wraps it must forward that argument and the original Request object, or every
client shares one IP rate-limit bucket. Construction performs no background work or signal registration. Startup selects the
configured database, constructs the app and schedules jobs; one active runtime per process is
supported. Repeated start/stop calls share their operation, and a stopped runtime cannot restart.
Stop refuses new requests, drains active requests and scheduled work, then closes resources.
Process entrypoints explicitly register signal handling with the existing ten-second deadline.

The optional `scheduler.schedule({ name, runOnce, pollIntervalMs })` returns a handle with
`stop(): Promise<void>`. An adapter must stop future invocations and await in-flight work. The
public polling scheduler remains the default. This interface does not move billing logic into the
scheduler and does not support multiple databases or merchant movement by itself.

`quotum-api/testing/merchant` exports `createMerchantTestRuntime({ composeApp? })` for disposable
browser integration. It reuses the public synthetic providers and control server and requires the
existing explicit test flags and loopback origin. Callers must stop its returned runtime. Production
code must not import this testing export. The standalone test entrypoint uses the same factory.

Distributions invoke the pinned checkout's `migrate` and `migrate:status` commands. Core migrations
remain unchanged and checksum-verified; private migration coordination does not authorize edits to
core SQL or ledger tables. Generic merchant features remain available to standalone operators.
