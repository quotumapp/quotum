# MCP server

- Document kind: Current behavior

`src/mcp/` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
coding agents such as Claude Code and Cursor. It answers questions about one project instance, a
sandbox or, with a read-only key, production: why a consume is denied, what an idempotency key
resolved to, why a product backend is not receiving `billing_state_v1`, and what the catalog
contains.

It is an HTTP client of the `/v1` API through the bundled SDK. It has no database access, adds no
route to the service, and holds one project API key and nothing else. It speaks stdio only.

## Run it

Use a sandbox key as in the [quickstart](quickstart.md#2-create-a-project-and-its-credential), or
issue a [read-only key](operations.md#read-only-credentials) for sandbox or production, then register
the server with the agent host. For Claude Code:

```sh
claude mcp add quotum \
  -e QUOTUM_MCP_BASE_URL=https://billing.example.com \
  -e QUOTUM_MCP_API_KEY=sqpk_... \
  -- bun --no-env-file /path/to/quotum-api/src/mcp/index.ts
```

The released image carries the server too:

```sh
docker run -i --rm \
  -e QUOTUM_MCP_BASE_URL=https://billing.example.com \
  -e QUOTUM_MCP_API_KEY=sqpk_... \
  ghcr.io/quotumapp/quotum bun --no-env-file src/mcp/index.ts
```

From a container, `localhost` is the container itself. Reaching a service on the host or in the same
compose network over plain `http` needs `QUOTUM_MCP_ALLOW_INSECURE_HTTP=true`.

`bun run mcp` runs the same command from a checkout. Keep `--no-env-file`: hosts start MCP servers
in the directory of the project being edited, and Bun would otherwise load that project's `.env`,
which for a product backend holds billing credentials.

| Variable | Meaning |
| --- | --- |
| `QUOTUM_MCP_BASE_URL` | Billing API origin, optionally with a path prefix. No credentials, query string or fragment. `https` is required unless the host is `localhost`, `127.0.0.1` or `::1`. |
| `QUOTUM_MCP_API_KEY` | A read-only project key (`sqrk_` or `pqrk_`) or a sandbox full key (`sqpk_`), each a prefix plus 43 characters. |
| `QUOTUM_MCP_ALLOW_INSECURE_HTTP` | `true` sends the key over plain `http` to a non-loopback host, for example a compose service name. Logged to stderr at startup. |

The server reads no `BILLING_*` variable, so the key of a backend or of the catalog CLI is never
picked up from the environment.

## Credential policy

- Prefer a [read-only key](api.md#read-only-credentials). The API then refuses every write with
  `403 READ_ONLY_CREDENTIAL`, so the guarantee does not rest on this server. Every tool calls an
  operation that read-only keys may call; `tests/mcp/contract-allowlist.test.ts` checks that against
  the contract.
- A full production key (`pqpk_`) is refused at startup, before any request: it can also consume
  usage and execute commercial actions. A sandbox full key (`sqpk_`) is accepted because that is what
  a developer already holds.
- The operator key is never used. Operator routes are therefore out of reach: catalog products,
  catalog preview and publication, enterprise contracts, promotion administration and
  `/v1/admin/metrics`.
- API-key mode only. A gateway-mode deployment puts the server behind its gateway, which sends
  `x-billing-credential-access: read_only` for it.

## Tools

Every tool is read-only. Lists return one page of at most 25 rows (10 by default) with `nextCursor`;
the server never follows a cursor on its own.

| Tool | Reads |
| --- | --- |
| `get_project_stats` | Store events and projection jobs by status, subscriptions needing attention, latest provider events |
| `find_customer` | Prefix search across account, customer, provider, transaction and order ids; `email` only with `includeEmail` |
| `get_customer_overview` | Customer detail, billing summary and effective controls; each section is data or an error; `email` only with `includeEmail` |
| `get_controls` | Effective spend and usage limits for an account or entity |
| `get_balance` | One feature's balance; allocation rows with `includeBreakdown` |
| `check_usage` | Whether a quantity would be allowed now, with reason, control and rate card. Records nothing |
| `get_usage_operation` | What an idempotency key resolved to; tries every operation kind when none is given |
| `list_usage_events` | Accepted consumes, confirmations and corrections; `metadata` only with `includeMetadata` |
| `list_projection_jobs` | Projection delivery state with `lastError` and `nextAttemptAt`; never the snapshot payload |
| `list_store_events`, `get_store_event` | Provider events and their processing state; never the raw payload |
| `get_catalog` | The published catalog with its revision: features, plans, meters, top-ups and rate cards; `sections` narrows a large one |
| `get_stripe_catalog` | What Stripe Checkout can sell; `STRIPE_NOT_CONFIGURED` without a Stripe connection |
| `get_provider_capabilities` | Operations each connected provider supports in this environment |
| `get_available_actions` | Commercial actions available for an account, with capability reasons |

| `find_api_operations`, `get_api_operation` | The generated `/v1` contract: search operations, then one operation with every schema it references. They read `contracts/v1` next to the server and never call the API |

The error inventory and the provider capability table are also served as resources
(`quotum://contracts/v1/errors.json`, `quotum://contracts/v1/provider-capabilities.json`). The
1.8 MB OpenAPI document is not, which is what the two contract tools are for. Without a
`contracts/v1` directory beside `src/` the contract tools and resources are not registered.

A denied consume records no usage event. Explain a denial with `check_usage`, or with
`get_usage_operation` while the outcome is retained (about 24 hours).

## Safeguards

- Read-only is enforced in the HTTP layer, not by tool annotations. The server's `fetch` allows a
  fixed list of `GET` routes plus `POST .../usage/check`, and rejects operator, actor and idempotency
  headers and `includeRawPayload`. `tests/mcp/inventory.test.ts` fails when a tool or an allowed
  route is added without the other.
- Requests do not follow redirects, time out after 15 seconds and cap the response size.
- A failure reaches the model as the API's error code, status and message, plus
  `rateLimitResetAt` on a 429. The server never retries. Anything else (network errors, a proxy's
  HTML page) becomes a generic message, with the detail on stderr.
- Usage-event `metadata`, external identifiers and provider fields are supplied by merchants, end
  users or providers. Free-form fields are left out by default, and an agent must treat whatever it
  reads as data, not as instructions.
- Tool results go to the agent's model provider. Customer email addresses are left out unless a call
  sets `includeEmail`; decide whether production data may go there before using a production key.
- stdout carries only protocol messages; diagnostics go to stderr with the key redacted. The process
  exits when the host closes stdin.

Requests count against the project's normal rate limits (60 per minute per admin path by default).
