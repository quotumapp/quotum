# Self-hosting Quotum

Quotum Cloud runs Quotum together with a merchant web application. A self-hosted Quotum runs
**headless**: the `/v1` API your backends call, provider webhooks and the background workers,
operated with the `quotum` command-line tool. This guide takes a deployment from nothing to a
verified production setup. Each step links to the reference that owns the details.

## What headless includes

A [headless](deployment.md#headless-mode) deployment (`QUOTUM_MERCHANT_ENABLED=false`) has:

- the `/v1` API, provider webhooks, every worker and signed projections to your backend;
- projects and environments declared in a [bootstrap manifest](deployment.md#first-start);
- connections and project API keys managed with `quotum connections` and `quotum credentials`;
- optional [private projection receivers](providers.md#private-receivers-headless-only);
- the stdio [MCP server](mcp.md).

These features exist only in Quotum Cloud's merchant application:

- `/api/*`, sign-up, onboarding, teams and invitations;
- step-up confirmation and merchant email;
- production activation;
- remote MCP;
- the Stripe App OAuth install. Headless deployments use Stripe restricted keys instead.

## Prerequisites

- Docker with Compose 2.24 or later, or your own orchestrator running the same image.
- A public hostname with ports 80 and 443 open for automatic HTTPS, or your own TLS proxy.
- Stripe restricted keys, or Apple or Google Play credentials, for each environment you sell in.
- A backend that receives projections (see the
  [reference receiver](../scripts/projection-receiver.ts)).

## 1. Generate the deployment's secrets

```sh
cd deploy/compose
cp .env.example .env && chmod 600 .env
docker run --rm ghcr.io/quotumapp/quotum:<version> quotum init >> .env
```

Then fill in two values in `.env`:

- `QUOTUM_VERSION`: pin the release by digest, such as `1.2.3@sha256:<digest>`.
- `POSTGRES_PASSWORD`: letters and digits only.

Keep copies of `QUOTUM_SECRETS_KEY_ID`, `QUOTUM_SECRETS_KEY_BASE64` and
`BILLING_OPERATOR_API_KEY` in your secret manager. Stored connections cannot be decrypted without
the key. `QUOTUM_AUTH_SECRET` keys the request fingerprints of the connection and credential
commands.

## 2. Start the stack

```sh
QUOTUM_DOMAIN=billing.example.com docker compose -f compose.yaml -f compose.tls.yaml up -d
curl -f https://billing.example.com/ready
```

- The TLS overlay adds Caddy, which obtains a certificate for `QUOTUM_DOMAIN`. Without the overlay,
  the API listens on `127.0.0.1:3000` only.
- `migrate` applies the schema before `api` starts.
- The [compose reference](deployment.md#headless-docker-compose) lists what each service does.

## 3. Declare your projects

Write the topology to `platform.json`. Headless deployments have no production activation flow, so
declare production `active` here:

```json
{
	"version": 1,
	"organizations": [
		{
			"slug": "acme",
			"name": "Acme",
			"projects": [
				{
					"key": "app",
					"name": "Acme App",
					"instances": [
						{ "key": "app-sandbox", "environment": "sandbox", "lifecycleStatus": "active", "issueCredential": true },
						{ "key": "app", "environment": "production", "lifecycleStatus": "active", "issueCredential": true }
					]
				}
			]
		}
	]
}
```

```sh
docker compose exec -e BILLING_PLATFORM_BOOTSTRAP_JSON="$(cat platform.json)" api \
  quotum bootstrap --check
docker compose exec -e BILLING_PLATFORM_BOOTSTRAP_JSON="$(cat platform.json)" api \
  quotum bootstrap --apply --credentials-out /tmp/credentials.json
(umask 077; docker compose exec -T api cat /tmp/credentials.json > credentials.json)
docker compose exec api rm /tmp/credentials.json
```

Move each key into your backends' secret store, then delete `credentials.json`.

To add an environment, project or organization later, extend `platform.json`, review `--check`, and
apply again with a new `--credentials-out` path. Bootstrap only
[adds missing rows](deployment.md#first-start). It never changes or deletes rows, and it never
rotates keys.

## 4. Connect your backend and providers

Commands read their files inside the container. Copy in the non-secret settings, and pipe secrets
through stdin so they never touch the container's disk. `--actor` names you in the audit log.

For the projection to your backend:

```sh
echo '{"projectionUrl":"https://backend.example.com/billing"}' > projection.json
docker compose cp projection.json api:/tmp/projection.json
docker compose exec api quotum connections draft app-sandbox projection --actor you@example.com \
  --settings /tmp/projection.json --secret-out /tmp/projection-secret.json
docker compose exec api cat /tmp/projection-secret.json   # give this to your backend
docker compose exec api rm /tmp/projection-secret.json
docker compose exec api quotum connections commit app-sandbox projection <draft-id> --actor you@example.com
```

`commit` checks that your backend answers the signed verification challenge. For each provider:

1. Copy the provider's settings in the same way, then draft with the secrets on stdin:

   ```sh
   docker compose exec -T api quotum connections draft app stripe --actor you@example.com \
     --settings /tmp/stripe.json --secrets-file - < stripe-secrets.json
   ```

2. For the active production environment, point the provider's webhook at the printed
   `setupWebhookPath`, then commit with `--wait-for-event 10m` and send a test event.
3. Point the webhook at `https://<domain>/v1/projects/<instance>/webhooks/<provider>`.

The field names and event lists for each provider are in
[headless connection setup](providers.md#headless-connection-setup).

## 5. Publish your catalog

Declare features, plans and top-ups, and bind them to your provider products. Then preview and
publish them with `quotum catalog diff <file>` and `quotum catalog push <file>`, which call the
[catalog API](api.md#catalog-publication). Both commands need `BILLING_BASE_URL`, a project key and
the operator key. `quotum catalog status` shows what is live.

## 6. Keep backends on a private network (optional)

If your backends share a private network with Quotum, approve that network for projections with
`BILLING_PROJECTION_ALLOWED_NETWORKS` in `.env`. Add `BILLING_PROJECTION_ALLOW_INSECURE_HTTP=true`
to send them plain http. Read the
[risks and limits](providers.md#private-receivers-headless-only) first.

## Operate

- **Backups.** Dump the database regularly and keep the encryption key elsewhere:

  ```sh
  docker compose exec postgres pg_dump -U quotum -Fc quotum > quotum-$(date +%F).dump
  ```

  See [backup and restore](operations.md#backup).
- **Rotation.**
  - Replace a project key with
    `quotum credentials rotate <instance> --access full --credentials-out <new-file> --actor <you>`.
    The old key stops working at once, so update your backends right away.
  - Re-encrypt connections under a new key with `quotum connections rotate-secrets`, following
    [encryption-key rotation](deployment.md#encryption-key-rotation).
- **Usage partitions.** Upkeep runs automatically, and `quotum partitions status` shows how far
  ahead the partitions reach. Alert on
  `billing_usage_partition_upkeep_runs_total{result=~"blocked|forbidden|failed"}`, as described in
  [usage partitions](operations.md#usage-partitions).
- **Metrics.** Scrape `api:3000/metrics` from inside the Compose network. The TLS proxy never
  serves it. See [health, readiness and metrics](operations.md#health-readiness-and-metrics).

## Upgrade

1. Read the target release and the pull requests it lists.
2. Take a backup.
3. Change `QUOTUM_VERSION` to the new digest, then run `docker compose pull` and
   `docker compose up -d`. `migrate` runs before the new API starts.
4. Before 1.0, schema baselines still change in place. If `quotum migrate` stops on a checksum
   mismatch, keep the old version running and follow the release's data-preserving steps in the
   [schema policy](operations.md#schema-and-upgrade-policy). Never reset a database that holds
   customer data.

## Known limits

- `quotum catalog provision` skips instances that already have a published catalog. It does not
  create Apple or Google Play products; create them in those stores.
- Headless deployments have no production activation flow. Declare production `active` in the
  bootstrap manifest.
- Schema baselines evolve in place until 1.0, so upgrades before then can need manual steps.
