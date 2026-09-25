# MCP server

- Document kind: Current behavior

`src/mcp/` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
coding agents such as Claude Code, Codex and Cursor. It answers questions about one project instance, a
sandbox or, with a read-only key, production: why a consume is denied, what an idempotency key
resolved to, why a product backend is not receiving `billing_state_v1`, and what the catalog
contains.

The shared tools use the bundled SDK and a fixed read-only request allowlist. The stdio transport
calls `/v1` with a project key. The optional remote transport runs at `/mcp` in the API process and
dispatches through the merchant billing port with browser-authorized identity, without project keys.

## Connect in a browser

Enable the remote transport with `QUOTUM_MCP_ENABLED=true` and
`QUOTUM_MCP_PUBLIC_ORIGIN=https://api.example.com`. The latter is the exact public API origin,
without a path or trailing slash. HTTPS is required (tests may use loopback HTTP). Deploy the
matching merchant UI and BFF before enabling it; [deployment](deployment.md#remote-mcp) describes
the public routes and schema ordering.

Add `https://api.example.com/mcp` to a coding client. Authorization opens the merchant application,
requires a fresh password plus email OTP or Google sign-in, then asks for one organization,
project, and environment and explicit read-only consent. An existing console session does not
skip sign-in. Sandbox and production require separate authorizations. The displayed identity is
the fresh sign-in identity, which may differ from the console identity.

Public clients `quotum-claude-code` and `quotum-cursor` are pre-registered with loopback callback
URIs `http://localhost:8788/callback` and `http://localhost:8787/callback`, respectively. The
provider permits variable ports for the registered loopback host/path. Supply the corresponding
client ID in hosts that need pre-registration. Clients supporting Client ID Metadata Documents
(CIMD), including the targeted Codex flow, use their HTTPS metadata URL as their client ID.
Dynamic client registration is disabled. Desktop-client compatibility still requires verification
against the deployed public origins; the local integration suite exercises protocol and auth flows.
Callback URIs must use HTTPS or HTTP loopback; private-use schemes are rejected both in
authorization requests and fetched client metadata, including metadata without an application type.

The server uses authorization code with PKCE S256 and the `/mcp` resource indicator. It issues
15-minute bearer access tokens and rotating refresh tokens. Authorization expires 30 days after
environment selection regardless of refreshes. DPoP, client secrets, client credentials grants,
and MCP write tools are not supported.

In **Developer setup → MCP connections**, view and revoke your connections for the selected
environment. Revocation immediately invalidates access tokens, refresh tokens, and cached refresh
responses for that immutable authorization; reconnecting never revives an older authorization.
Authorization-code replay, including concurrent redemption, revokes the affected authorization.
Password reset and principal/membership suspension revoke affected authorizations. Every tool
request and refresh rechecks current principal, membership, environment, and grant access.

Discovery lives on the API origin at `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`. The authorization endpoint is on the UI origin;
`/oauth/token`, `/oauth/revoke`, and `/oauth/jwks` are cookie-free API endpoints. Browser auth and
selection stay behind the BFF's exact route allowlist, service identity, Origin and CSRF checks.
An auth proof belongs to one OAuth request and cannot be exchanged for a console session or
step-up grant. Environment selection and consent require a proof issued within five minutes.
An accepted authorization code has its own five-minute redemption window. The transient session
is retained through that window without extending browser proof freshness, then removed after
issuance, including an issuance rejected by the final access check. Refresh credentials survive
deletion of the transient proof.

Remote requests reject unexpected Host/Origin headers, cap MCP bodies at 256 KiB and token forms at
16 KiB, and apply limits of 300 requests per minute per connecting IP and 120 authenticated MCP
requests per minute per principal. The proxy must preserve the configured Host and pass Bun's
server object to the runtime so its connection address is available. These checks run only on
the remote MCP and OAuth endpoints; staff, merchant and health routes use their own policies.
The transport is stateless,
with current MCP messages and the SDK's older-protocol fallback; it keeps no cross-request session.

## Run over stdio

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
  ghcr.io/quotumapp/quotum quotum mcp
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

- Read-only is enforced at the request boundary, not by tool annotations. The server's `fetch` allows a
  fixed list of `GET` routes plus `POST .../usage/check`, and rejects operator, actor and idempotency
  headers and `includeRawPayload`. `tests/mcp/inventory.test.ts` fails when a tool or an allowed
  route is added without the other.
- Outbound stdio HTTP requests do not follow redirects, time out after 15 seconds and cap the response size.
- A failure reaches the model as the API's error code, status and message, plus
  `rateLimitResetAt` on a 429. The server never retries. Anything else (network errors, a proxy's
  HTML page) becomes a generic message. Stdio logs diagnostic detail to stderr; remote failures
  report through the scrubbed service logger and MCP request isolation scope, retaining error
  diagnostics and a request ID while keeping them out of protocol responses.
- Usage-event `metadata`, external identifiers and provider fields are supplied by merchants, end
  users or providers. Free-form fields are left out by default, and an agent must treat whatever it
  reads as data, not as instructions.
- Tool results go to the agent's model provider. Customer email addresses are left out unless a call
  sets `includeEmail`; decide whether production data may go there before using a production key.
- For stdio, stdout carries only protocol messages; diagnostics go to stderr with the key redacted. The process
  exits when the host closes stdin.

Stdio requests count against the project's normal [rate limits](deployment.md#rate-limits) (60 per
minute per admin route by default, shared by every customer that route reads). Remote requests use
the principal/IP limits above.
