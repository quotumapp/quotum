#!/bin/sh
# Starts the headless stack from nothing and checks it end to end:
# image, migrations, headless API, platform bootstrap and an authenticated /v1 call.
#
#   QUOTUM_IMAGE=quotum-api QUOTUM_VERSION=ci deploy/compose/smoke.sh
#
# Everything it creates, volumes included, is removed on exit.
set -eu

cd "$(dirname "$0")"
image_name="${QUOTUM_IMAGE:-ghcr.io/quotumapp/quotum}"
image_version="${QUOTUM_VERSION:?Set QUOTUM_VERSION to the image tag to test}"
port="${QUOTUM_PORT:-3000}"
workdir=$(mktemp -d)
env_file="$workdir/.env"

compose() {
	QUOTUM_ENV_FILE="$env_file" docker compose --project-name quotum-smoke \
		--env-file "$env_file" "$@"
}

cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		compose logs --no-color || true
	fi
	compose down --volumes --remove-orphans >/dev/null 2>&1 || true
	rm -rf "$workdir"
	exit "$status"
}
trap cleanup EXIT

umask 077
{
	docker run --rm "$image_name:$image_version" quotum init
	printf 'QUOTUM_IMAGE=%s\n' "$image_name"
	printf 'QUOTUM_VERSION=%s\n' "$image_version"
	printf 'QUOTUM_PORT=%s\n' "$port"
	printf 'POSTGRES_PASSWORD=%s\n' "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
} >"$env_file"

compose config --quiet
QUOTUM_DOMAIN=smoke.invalid compose --file compose.yaml --file compose.tls.yaml config --quiet
docker run --rm --volume "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" --env QUOTUM_DOMAIN=smoke.invalid \
	caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

compose up --detach
attempt=0
until curl --silent --fail "http://127.0.0.1:$port/ready" >/dev/null; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 60 ]; then
		echo "The API did not become ready." >&2
		exit 1
	fi
	sleep 2
done
compose exec -T api quotum healthcheck

manifest='{"version":1,"organizations":[{"slug":"smoke","name":"Smoke Test","projects":[{"key":"smoke","name":"Smoke Test","instances":[{"key":"smoke-sandbox","environment":"sandbox","lifecycleStatus":"active","issueCredential":true}]}]}]}'
compose exec -T --env BILLING_PLATFORM_BOOTSTRAP_JSON="$manifest" api \
	quotum bootstrap --apply --credentials-out /tmp/smoke-credentials.json
compose exec -T --env BILLING_PLATFORM_BOOTSTRAP_JSON="$manifest" api \
	quotum bootstrap --check >/dev/null
token=$(compose exec -T api cat /tmp/smoke-credentials.json |
	sed -n 's/.*"credential": "\([^"]*\)".*/\1/p')
if [ -z "$token" ]; then
	echo "The bootstrap wrote no credential." >&2
	exit 1
fi

# The throwaway sandbox key authenticates from the host and through the CLI in the container.
printf 'Authorization: Bearer %s\n' "$token" >"$workdir/authorization"
curl --silent --fail --header "@$workdir/authorization" \
	"http://127.0.0.1:$port/v1/admin/catalog" >/dev/null
compose exec -T --env BILLING_BASE_URL=http://127.0.0.1:3000 --env BILLING_PROJECT_API_KEY="$token" \
	api quotum catalog status >/dev/null

echo "The headless compose stack is healthy."
