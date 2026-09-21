# MCP server

- Document kind: Current behavior

`src/mcp/` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
coding agents such as Claude Code and Cursor. It answers questions about one sandbox project
instance: why a consume is denied, what an idempotency key resolved to, why a product backend is
not receiving `billing_state_v1`, and what the purchasable catalog contains.

It is an HTTP client of the `/v1` API through the bundled SDK. It has no database access, adds no
route to the service, and holds one project API key and nothing else. It speaks stdio only.

## Run it

Create a sandbox key as in the [quickstart](quickstart.md#2-create-a-project-and-its-credential),
then register the server with the agent host. For Claude Code:

```sh
claude mcp add quotum \
  -e QUOTUM_MCP_BASE_URL=https://billing.example.com \
  -e QUOTUM_MCP_API_KEY=sqpk_... \
  -- bun --no-env-file /path/to/quotum-api/src/mcp/index.ts
```

`bun run mcp` runs the same command from a checkout. Keep `--no-env-file`: hosts start MCP servers
in the directory of the project being edited, and Bun would otherwise load that project's `.env`,
which for a product backend holds billing credentials.

| Variable | Meaning |
| --- | --- |
| `QUOTUM_MCP_BASE_URL` | Billing API origin, optionally with a path prefix. No credentials, query string or fragment. `https` is required unless the host is `localhost`, `127.0.0.1` or `::1`. |
| `QUOTUM_MCP_API_KEY` | A sandbox project API key (`sqpk_` plus 43 characters). |
| `QUOTUM_MCP_ALLOW_INSECURE_HTTP` | `true` sends the key over plain `http` to a non-loopback host, for example a compose service name. Logged to stderr at startup. |

The server reads no `BILLING_*` variable, so the key of a backend or of the catalog CLI is never
picked up from the environment.

## Credential policy

- Sandbox keys only. A production key (`pqpk_`) is refused at startup, before any request: project
  keys are not scoped, so a production key could also consume usage and execute commercial actions.
  Production use waits for read-only project credentials.
- The operator key is never used. Operator-guarded reads are therefore out of reach: the versioned
  catalog (`GET /v1/admin/catalog`, with features, meters and rate cards), catalog products, enterprise
  contracts, promotion administration and `/v1/admin/metrics`.
- API-key mode only. A gateway-mode deployment must enforce the same restriction in its gateway.

## Tools

Every tool is read-only. Lists return one page of at most 25 rows (10 by default) with `nextCursor`;
the server never follows a cursor on its own.

| Tool | Reads |
| --- | --- |
| `get_project_stats` | Store events and projection jobs by status, subscriptions needing attention, latest provider events |
| `find_customer` | Prefix search across account, customer, provider, transaction and order ids |
| `get_customer_overview` | Customer detail, billing summary and effective controls; each section is data or an error |
| `get_controls` | Effective spend and usage limits for an account or entity |
| `get_balance` | One feature's balance; allocation rows with `includeBreakdown` |
| `check_usage` | Whether a quantity would be allowed now, with reason, control and rate card. Records nothing |
| `get_usage_operation` | What an idempotency key resolved to; tries every operation kind when none is given |
| `list_usage_events` | Accepted consumes, confirmations and corrections; `metadata` only with `includeMetadata` |
| `list_projection_jobs` | Projection delivery state with `lastError` and `nextAttemptAt`; never the snapshot payload |
| `list_store_events`, `get_store_event` | Provider events and their processing state; never the raw payload |
| `get_catalog` | The Stripe purchasable catalog; `STRIPE_NOT_CONFIGURED` without a Stripe connection |
| `get_provider_capabilities` | Operations each connected provider supports in this environment |
| `get_available_actions` | Commercial actions available for an account, with capability reasons |

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
- stdout carries only protocol messages; diagnostics go to stderr with the key redacted. The process
  exits when the host closes stdin.

Requests count against the project's normal rate limits (60 per minute per admin path by default).
