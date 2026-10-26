# MCP server

- Document kind: Current behavior

`src/mcp/` is a [Model Context Protocol](https://modelcontextprotocol.io) server for
coding agents such as Claude Code, Codex and Cursor. Remote connections answer questions across one organization; stdio uses one sandbox or, with a
read-only key, production instance: why a consume is denied, what an idempotency key
resolved to, why a product backend is not receiving `billing_state_v1`, and what the catalog
contains.

The shared tools use the bundled SDK and a fixed read-only request allowlist. The stdio transport
calls `/v1` with a project key. The optional remote transport runs at `/mcp` in the API process and
dispatches through the merchant billing port with browser-authorized identity, without project keys.

For first-time self-hosted configuration, the separate
[local operator MCP](#local-operator-mcp-for-self-hosted-setup) runs the operator commands through
typed tools. It has database authority and must be launched explicitly; it is not part of the
shared read tools or the remote HTTP transport.

## Connect in a browser

Browser authorization uses merchant sign-in, so the remote transport needs the merchant console:
set `QUOTUM_CONSOLE_ENABLED=true`. The default, [headless mode](deployment.md#headless-mode),
serves no `/mcp` and refuses `QUOTUM_MCP_ENABLED=true` at startup; the stdio server works in both
modes. With the console on, enable the remote transport with `QUOTUM_MCP_ENABLED=true` and
`QUOTUM_MCP_PUBLIC_ORIGIN=https://api.example.com`. The latter is the exact public API origin,
without a path or trailing slash. HTTPS is required (tests may use loopback HTTP). Deploy the
matching merchant UI and BFF before enabling it; [deployment](deployment.md#remote-mcp) describes
the public routes and schema ordering.

Add `https://api.example.com/mcp` to a coding client. Authorization opens the merchant application,
requires a fresh password plus authenticator code, or Google sign-in, then asks for one organization
and explicit consent to the requested scopes. A client that requests change
proposals can still be connected read-only: the consent page shows **Propose changes** as a separate
choice, and leaving it unticked drops only `quotum.billing.write`. A role that cannot approve any
change, such as Viewer, can only connect read-only. An existing console session does not
skip sign-in. The connection includes all current and future projects and environments in that
organization. The displayed identity is
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
1-hour bearer access tokens and rotating refresh tokens. Authorization expires 30 days after
organization selection regardless of refreshes. DPoP, client secrets, client credentials grants,
and direct MCP execution of mutations are not supported.

In **Developer setup → MCP connections**, view and revoke your connections for the selected
organization; each shows whether it is read-only or can propose changes. Revocation immediately invalidates access tokens, refresh tokens, and cached refresh
responses for that immutable authorization; reconnecting never revives an older authorization.
Authorization-code replay, including concurrent redemption, revokes the affected authorization.
Password reset and principal/membership suspension revoke affected authorizations. Every tool
request and refresh rechecks current principal, organization membership and grant access. Each billing call also checks its explicit target.

A refresh token that was already rotated, presented after its 30-second replay window, also revokes
the authorization. Each revocation writes an `mcp.revoked` audit event whose `reason` says why a
client had to sign in again: `user` (Disconnect in the console), `client` (the client's own
`/oauth/revoke`), `code_replay`, `refresh_replay`, `issuance_failed`, `password_reset` or
`second_factor_reset` (an operator reset the person's authenticator), or `scope_changed` (the
organization-scope upgrade requires fresh consent).

Discovery lives on the API origin at `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`. The authorization endpoint is on the UI origin, so the
metadata advertises `authorization_response_iss_parameter_supported` and every authorization
response carries `iss` (RFC 9207); clients such as Codex refuse an authorization endpoint on
another origin without it.
`/oauth/token`, `/oauth/revoke`, and `/oauth/jwks` are cookie-free API endpoints. Browser auth and
selection stay behind the BFF's exact route allowlist, service identity, Origin and CSRF checks.
The token and revoke endpoints read only `application/x-www-form-urlencoded` bodies, and the
merchant API reads only `application/json`: the media type matches exactly, ignoring case and
allowing parameters such as `charset`, so `application/jsonx` and `application/json-seq` answer
`415`. A wrong method on these or the discovery endpoints answers `405` with `Allow`, and an unknown
path `404`; neither is reported as an outage. The sign-in library's own rate limit answers
`429 RATE_LIMITED` with `Retry-After`, as `{error, error_description}` on `/oauth/token` and in the
merchant error envelope on `/api/auth/*`.
An auth proof belongs to one OAuth request and cannot be exchanged for a console session or
step-up grant. Organization selection and consent require a proof issued within five minutes.
An accepted authorization code has its own five-minute redemption window. The transient session
is retained through that window without extending browser proof freshness, then removed after
issuance, including an issuance rejected by the final access check. Refresh credentials survive
deletion of the transient proof.

Remote requests reject unexpected Host/Origin headers, cap MCP bodies at 256 KiB and token forms at
16 KiB, and apply limits of 300 requests per minute per client IP and 120 authenticated MCP
requests per minute per principal. The client IP is the connecting address, so the proxy must
preserve the configured Host and the runtime must receive Bun's server object. Behind a reverse
proxy that address is the proxy's and every client shares one budget, including the sign-in
library's limit on the token endpoint: set
[`BILLING_TRUST_PROXY_HEADERS=true`](deployment.md#rate-limits) there, so these limits count the
forwarded client as the `/v1` limits do. These checks run only on
the remote MCP and OAuth endpoints; staff, merchant and health routes use their own policies.
The transport is stateless,
with current MCP messages and the SDK's older-protocol fallback; it keeps no cross-request session.

## Choose a project and environment

Remote authorization binds one organization, not an active environment. Start with `list_projects`:
it returns that organization's project keys and available sandbox/production environments, with
`active` status. An organization with no projects can connect; projects provisioned
later appear without reconnecting. Internal and suspended environments are unavailable.

Every environment-specific read, `get_mcp_capabilities`, `get_billing_configuration` and
`prepare_billing_change` requires explicit top-level `projectKey` and `environment` arguments:

```json
{"projectKey":"my-app","environment":"production","sections":["plans"]}
```

That is a `get_catalog` input. No tool changes a shared active environment, so parallel calls can
address different projects safely. Organization authority comes from consent; tool arguments cannot
select another organization. The contract tools and `list_projects` need no target. Proposal get
and cancel tools use the saved proposal's ID; `list_billing_changes` returns the latest 25 proposals
across the connection, each with its own scope. Stdio keeps its existing single-instance arguments.

A suspended environment refuses calls targeting it while the connection keeps working elsewhere.
Disconnecting the connection ends access across the organization. Existing environment-level
connections must reconnect after the [organization cutover](upgrade-transitions.md#organization-scoped-remote-mcp).

## Connect to production immediately

Production is active from project creation, even before credentials, integrations or a catalog
have been configured. `list_projects` discovers both environments, and the organization connection
can use the normal read tools immediately. Proposals retain explicit write consent, current
permissions, browser approval and applicable production step-up authentication. Setup diagnostics
do not limit the connection to catalog operations. Suspended, deactivating and deactivated
environments remain unavailable.

## Propose billing changes

Remote writes are separately opt-in: set `QUOTUM_MCP_WRITES_ENABLED=true` only after deploying
matching schema, API and merchant UI. Proposals need API v0.22.4 or later: earlier versions stored
a proposal in a form that could not be approved, and refused every usage correction, automatic
top-up reset and commercial action as stale. The first-party console serves the review page that
the returned URL opens, `/mcp/changes/{id}`, from the release that pins the v0.22.4 contract; an
older console answers that URL with "Page not found", so deploy the console before turning the flag
on. Clients must request `quotum.billing.write` alongside `quotum.read`
and `offline_access` and complete fresh consent. Existing grants retain their saved
scopes; enabling the flag does not upgrade them. Stdio remains read-only, even with a sandbox key.

The consent decides the final scopes, and it can only narrow the request. The browser sends the
chosen `scope` with the consent; it must be the requested scopes or those minus
`quotum.billing.write`, because every tool needs `quotum.read` and refreshing needs
`offline_access`. Anything else is refused as `invalid_grant`. The grant stores the final scopes, the
token response and access tokens carry them, and the change tools exist only when the grant and the
token both include the write scope. A role without any capability that a proposed change needs
(`operations.write`, `operations.recover` or catalog publication) is refused the write scope with
`FORBIDDEN`; `canPropose` on each organization in the authorization context tells the page which
roles that is. The role is checked again when a change is prepared and approved, so a member who
loses the role keeps a connection that can read but can no longer prepare or approve changes.

Write-consented connections gain these tools:

| Tool | Behavior |
| --- | --- |
| `get_mcp_capabilities` | Lists available actions under current merchant permissions. |
| `get_billing_configuration` | Reads entities, grants, debits, trials, controls, alerts, top-up policies, license pools, enterprise contracts and promotions. |
| `prepare_billing_change` | Saves a typed proposal and returns a browser review URL. Does not apply it. |
| `get_billing_change` / `list_billing_changes` | Read proposal status and recorded outcome. |
| `cancel_billing_change` | Withdraws a pending proposal. |

A proposal's text (request key, reason, parameters and body) cannot contain NUL or unpaired
surrogate characters; `prepare_billing_change` refuses it as invalid input.

Account-scoped changes retain the trusted API's account requirements. Before preparing an entity,
the product backend must create its billing account with
`PUT /v1/billing-accounts/:billingAccountId`; a proposal never creates a missing account implicitly.
For example, for an existing account, prepare an entity with:

```json
{
  "projectKey": "my-app",
  "environment": "sandbox",
  "requestKey": "create-team-a-1",
  "reason": "Track Team A usage separately",
  "change": {
    "action": "entities.write",
    "parameters": ["customer-123"],
    "body": {"externalId": "team-a", "kind": "team"}
  }
}
```

The tool schema lists supported actions and their existing domain body schemas. They cover catalog
publication (including default-plan configuration), migrations, commercial actions, entities,
shared/entity grants and debits, controls, trials, alerts, auto-top-ups, licenses, contracts,
promotions, usage corrections, event replay and projection retry. Credential, connection, team,
environment administration, global reconciliation, usage consumption and refunds are excluded.

Every effective change requires the same connected merchant to open the returned URL, review it,
and choose **Approve and apply**, including in sandbox. Production and sensitive recovery/correction
actions also require the existing step-up authentication: the console opens a challenge bound to
`POST /api/platform/mcp/changes/{id}/approve` and the proposal's hash, asks the merchant for a code
from their authenticator app (or a recovery code) without leaving the page, and sends the approval
with the grant once the code is confirmed. The backend rechecks the live session,
connection and role. The agent must present the URL to the user, never approve it itself. There is
no MCP execute tool and no arbitrary HTTP passthrough.

The review page reads the change from `GET /api/platform/mcp/changes/{id}`; the approve and reject
answers carry the same view. Besides `before` and `after`, that view carries `body`, the validated
request the app proposed. For catalog, contract and migration publication and for commercial actions
`after` is the domain preview: it says what approving would do (counts, a revision number), not what
was asked, so only `body` lets the page name the plans and features a catalog publishes. The MCP
tools leave `body` out of `prepare_billing_change`, `get_billing_change` and `list_billing_changes`:
the agent that wrote the request has it, and a catalog's `before` already holds the whole published
catalog, which would push a result toward the size cap. A console built against a contract before
`body` ignores the field and shows `before` and `after` only.

Proposals expire after at most one hour by default. Set `QUOTUM_MCP_PROPOSAL_TTL_SECONDS` to a
positive whole number of seconds to change the review window. The configured duration also applies
to fresh catalog, enterprise-contract, catalog-migration and commercial previews prepared for MCP
proposals; direct API and ordinary console previews keep their existing defaults. A reused preview
keeps its original deadline, and the proposal is always capped by its preview's expiry. The review
page shows the effective `expiresAt`. Restart the API to apply a configuration change to new
preparations; saved proposals, idempotent retries and reused previews keep their stored deadlines.
Merchant sessions and step-up grants retain their own expiry; sign in again if needed to approve.
Proposals are immutable:
use a new request key and `replacesChangeId` to replace a pending proposal. Reusing a key with changed
input or another target conflicts. Replacement is allowed only within the original instance. The
resolved instance is included in the proposal hash; approval and recovery always use that saved target.
Replacement previews run before the replacement is committed. Approval of the original can win
during that preview; the replacement then fails with `409 ACTION_REJECTED`, stores no new proposal
and leaves the approved operation intact. Approval compares the recorded state and domain preview
preconditions; stale proposals require a new preview. Database-only execution stores its receipt in the mutation's
transaction; repeated approval does not dispatch twice. Commercial execution retains its domain
idempotency key and can recover a saved result. An uncertain external outcome stays `needs_review`;
it is not automatically rerun. `completed` means the operation returned successfully, which may
mean a checkout link or queued job was created, not that payment or background processing finished.

Approving or rejecting a proposal that is no longer pending applies nothing: a replaced proposal is
`cancelled`, and others are `rejected`, `expired`, `applying`, `completed`, `failed`, `stale` or
`needs_review`. The call still answers `200` with the proposal as it now stands, so a client must
check `status` and never treat that response as an approval. Only a request whose `requestHash`
differs from the proposal's answers `409 ACTION_MISMATCH`.

Disabling the write flag prevents new proposals and approvals. Existing write-consented connections
can inspect results and cancel pending proposals while their authorization remains valid.

A [headless](deployment.md#headless-mode) deployment has no proposals at all. Applying a change
needs a merchant sign-in, a browser decision and, for production, step-up confirmation, and none of
those exist without the console. A headless process refuses `QUOTUM_MCP_WRITES_ENABLED=true`, like
`QUOTUM_MCP_ENABLED=true`, at startup. `quotum mcp` stays read-only. Headless operators can make
changes with the [operator CLI](deployment.md#operator-cli), the separate local operator MCP below,
or the `/v1` API.

Finished and abandoned proposals are deleted 30 days after they were created, and a connection's
record 30 days after it expired or was revoked. A deleted connection answers like a revoked one.
See [merchant platform retention](operations.md#merchant-platform-retention).

## Local operator MCP for self-hosted setup

`quotum mcp operator` lets an agent migrate the database, bootstrap organizations and environments,
configure connections, issue credentials, adopt provider bindings and publish catalogs without
shell tools, a merchant account or a browser approval. It runs as a local stdio process under
`src/composition/operator-mcp/`, using the existing operator CLI. It is never served at `/mcp`.

The host still supplies Bun or the container image, a reachable PostgreSQL 18 database, and the
deployment's stable `QUOTUM_SECRETS_KEY_ID`, `QUOTUM_SECRETS_KEY_BASE64` and `QUOTUM_AUTH_SECRET`.
Generate those once for a new deployment with [`quotum init`](deployment.md#operator-cli); use
the service's existing values when configuring an existing deployment. The tools configure
Quotum; they do not provision host infrastructure, deploy a projection receiver or administer a
provider's dashboard. Production connections retain the signed setup-event requirement.

Create a private directory (mode `700`) for provider secret inputs and generated secret outputs.
Put provider secrets in JSON files there, following
[headless connection setup](providers.md#headless-connection-setup). The process must be able to
read the inputs and create new files. Register this launcher with the agent host:

```json
{
  "mcpServers": {
    "quotum-operator": {
      "command": "/path/to/quotum-api/bin/quotum",
      "args": [
        "--env-file", "/srv/quotum/operator.env",
        "mcp", "operator", "--allow-writes",
        "--actor", "agent-setup",
        "--directory", "/srv/quotum/setup"
      ]
    }
  }
}
```

The explicit environment file contains `POSTGRES_URI` and the stable settings above, plus any
operator settings the deployment uses. Exported variables take precedence. Automatic `.env`
discovery remains disabled. The equivalent container launcher is:

```sh
docker run -i --rm --env-file /srv/quotum/operator.env \
  --mount type=bind,src=/srv/quotum/setup,dst=/setup \
  ghcr.io/quotumapp/quotum:<version> \
  quotum mcp operator --allow-writes --actor agent-setup --directory /setup
```

Join the database's Docker network when needed and make the mounted private directory accessible
to the image's `bun` user. Configure the database address as seen from that container.

The launch requires `--allow-writes`, a fixed audit `--actor` and the private `--directory`.
This grants operator authority across the configured database. Tool calls apply changes directly;
the remote proposal/browser flow is a separate authority. Do not expose this process as a network
service. Disconnect it after setup and use `quotum mcp` with a read-only key for routine inspection.

| Tools | Behavior |
| --- | --- |
| `get_setup_status` | Reports missing setting names, the actor and directory, never values. |
| `migrate_database` | Verifies checksums and lists migration status by default; `apply: true` applies pending migrations with the existing advisory lock. Status may create the migration bookkeeping table. Never resets data. |
| `inspect_bootstrap`, `apply_bootstrap` | Accept the [bootstrap manifest](../examples/quickstart/platform.json). Inspect first, then apply with `credentialsOut`; credential values go to that new file. |
| `list_connections`, `draft_connection`, `validate_connection`, `commit_connection` | Preserve the CLI's revision checks, validation, signed-event checks, actor attribution and member override requirements. Draft takes JSON settings plus a provider `secretsFile`, or a projection `secretOut`. Install the projection secret at the receiver before validation. |
| `get_credentials`, `rotate_credentials` | Inspect credential presence, then explicitly select `full` or `read_only`. Rotation immediately revokes the replaced key and writes the new key to `credentialsOut`. |
| `get_catalog`, `preview_catalog`, `publish_catalog` | Use JSON catalog data and an explicit `expectedRevision` (`null` for no published catalog). Preview persists a preview; publish revalidates and refuses stale revisions. Identical intent is a no-op. |
| `list_catalog_bindings`, `adopt_catalog_bindings` | Inspect/adopt existing provider products through the CLI's validated, actor-attributed receipts. |
| `get_environment_readiness` | Reports informational setup findings. These do not gate environment access or credential issuance. |

Secret input/output arguments are filenames within the host-selected directory, never arbitrary
paths. Secret inputs must be regular JSON files of at most 64 KB; symlinks are refused. Generated
keys/secrets use exclusive creation and mode `600`, so an existing file is not overwritten.
Catalogs are passed as JSON, never executable TypeScript/JavaScript modules. No tool accepts shell
commands or arbitrary CLI arguments. Setup calls accept at most 256 KB of JSON and run one command
at a time. Mutation tools that support `requestKey` require one; reuse it on retry.

Results carry the CLI `exitCode` and parsed `data`. Exit `2` means outstanding bootstrap/readiness
findings, not a tool failure. Raw provider/database diagnostics are withheld; failures expose the
domain error code when available. Inspect the target's state before retrying a failed or interrupted
write, which may have committed. Large successful results return a completion receipt instead of
the data. Commands have a ten-minute deadline; closing stdin drains outstanding requests for up to
30 seconds, and disconnect/signal shutdown terminates outstanding child commands.

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

The shared tools below are read-only. Lists return one page of at most 25 rows (10 by default) with `nextCursor`;
the server never follows a cursor on its own.

| Tool | Reads |
| --- | --- |
| `get_project_stats` | Store events and projection jobs by status, subscriptions needing attention, latest provider events |
| `find_customer` | Prefix search across account, customer, provider, transaction and order ids; `email` only with `includeEmail` |
| `get_customer_overview` | Customer detail, billing summary and effective controls; each section is data or an error; `email` only with `includeEmail` |
| `get_controls` | Effective spend and usage limits for an account or entity |
| `get_balance` | One feature's balance; allocation rows with `includeBreakdown` |
| `check_usage` | Boolean entitlement or metered `featureId`/`value` check for an existing account, with compact denial/control context. Records nothing |
| `get_usage_operation` | What an idempotency key resolved to; pass `entityId` for entity-scoped usage; tries every operation kind when none is given |
| `list_usage_events` | Accepted consumes, confirmations and corrections; `metadata` only with `includeMetadata` |
| `list_invoices`, `get_invoice` | The [invoices](metering.md#invoice-reads) Quotum mirrored for an account: a page newest first, then one with its lines; the hosted and PDF bearer links are never returned, whatever the key |
| `list_projection_jobs` | Projection delivery state with `lastError` and `nextAttemptAt`; never the snapshot payload |
| `list_store_events`, `get_store_event` | Provider events and their processing state; never the raw payload |
| `get_catalog` | The published catalog with its revision: features, plans, meters, top-ups and rate cards; `sections` narrows a large one |
| `get_stripe_catalog` | What Stripe Checkout can sell; `STRIPE_NOT_CONFIGURED` without a Stripe connection |
| `get_provider_capabilities` | Operations each connected provider supports in this environment |
| `get_available_actions` | Commercial actions available for an account, with capability reasons |

| `find_api_operations`, `get_api_operation` | The generated `/v1` contract: search operations, then one operation with every component it references. They read `contracts/v1` next to the server and never call the API |

The error inventory, the provider capability table and the
[projection delivery contract](providers.md#delivery-contract) are also served as resources
(`quotum://contracts/v1/errors.json`, `quotum://contracts/v1/provider-capabilities.json`,
`quotum://contracts/v1/projection-delivery.schema.json` and
`quotum://contracts/v1/projection-delivery.examples.json`). The
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
- For stdio, stdout carries only protocol messages; diagnostics go to stderr with the key redacted. When the host
  closes stdin or reading it fails, the process answers the requests it has already read, for up to
  ten seconds, and then exits.

Stdio requests count against the project's normal [rate limits](deployment.md#rate-limits) (60 per
minute per admin route by default, shared by every customer that route reads). Remote requests use
the principal/IP limits above.

Proposal admission is bounded per organization across connections and principals: 100 unexpired
`pending` or `applying` proposals (including in-flight preparations), 1000 admitted preparation attempts per UTC day,
2 MiB per complete stored envelope, and 64 MiB retained JSON by default. Quota refusals report
`MCP_QUOTA_EXCEEDED` with status 429; oversized snapshots report `MCP_PROPOSAL_TOO_LARGE` with status
413. MCP tool errors carry these codes in the protocol response. Replays of saved request keys
do not spend another preparation attempt. A duplicate key still preparing reports
`OPERATION_IN_PROGRESS`; failed previews spend their daily attempt and release capacity. An expired
preparation admission stores no proposal; retry with the same request key. `needs_review` and
expired `applying` proposals release the pending slot but keep their full retained-byte charge.
While unresolved, they remain available for outcome recovery and are never automatically rerun
or deleted.

The immutable review snapshot is rejected if too large. Each envelope reserves 64 KiB for its
execution result; a larger result becomes an explicit `responseOmitted` receipt with its status,
change ID and operation key. The approved mutation still has a durable result and its affected
resource can be inspected from the saved action/parameters. Expired admissions are reclaimed;
retention removes terminal snapshots and thirty-day daily counters. Existing oversized/over-quota
proposals remain reviewable. See [deployment settings](deployment.md) for quota overrides.
