import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createLocalProjectionReceiver } from "../helpers/projection-receiver";
import { resetAndSeedIntegrationData } from "../integration/helpers/catalog-fixtures";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
} from "../integration/helpers/fake-provider-clients";
import { e2eApiKey, e2eServiceEnv, signStripeWebhook } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { type BillingServiceProcess, startBillingService } from "./helpers/service-process";
import { createTcpProxy, type TcpProxy } from "./helpers/tcp-proxy";

const e2eDescribe = describeE2e(describe, describe.skip);
let sql: SQL;
let service: BillingServiceProcess | null = null;
let proxy: TcpProxy | null = null;
let receiver: ReturnType<typeof createLocalProjectionReceiver> | null = null;

e2eDescribe("E2E lifecycle", () => {
	beforeEach(() => {
		const postgresUri = process.env.POSTGRES_URI;
		if (postgresUri === undefined || postgresUri.trim() === "") {
			throw new Error("POSTGRES_URI is required for E2E tests");
		}
		sql = new SQL(postgresUri, { max: 2, idleTimeout: 1, maxLifetime: 0 });
	});

	afterEach(async () => {
		await service?.stop();
		service = null;
		receiver?.stop();
		receiver = null;
		await proxy?.stop();
		proxy = null;
		await sql?.close();
	});

	it("reports unavailable when Postgres is lost and recovers dynamically", async () => {
		proxy = await createPostgresProxy();
		service = await startBillingService(e2eServiceEnv({ postgresUri: proxiedPostgresUri(proxy) }));

		await expectStatus("/ready", 200);
		await expectAuthenticatedProjectStatus(200);
		await proxy.stop();
		await waitForStatus("/ready", 503);
		await expectStatus("/livez", 200);
		await expectAuthenticatedProjectStatus(503, "BILLING_PROJECT_CONTEXT_UNAVAILABLE");
		await proxy.start();
		await waitForStatus("/ready", 200);
		await expectAuthenticatedProjectStatus(200);
	});

	it("recovers readiness after a startup-time Postgres outage", async () => {
		proxy = await createPostgresProxy();
		await proxy.stop();
		service = await startBillingService(e2eServiceEnv({ postgresUri: proxiedPostgresUri(proxy) }));

		await expectStatus("/livez", 200);
		await expectStatus("/ready", 503);
		await proxy.start();
		await waitForStatus("/ready", 200);
	});

	it("finishes an in-flight projection on SIGTERM and releases locks", async () => {
		await resetAndSeedIntegrationData(sql);
		receiver = createLocalProjectionReceiver({ secret: "voysee-e2e-projection-secret" });
		const hold = receiver.holdNextResponse();
		service = await startBillingService(
			e2eServiceEnv({ postgresUri: process.env.POSTGRES_URI ?? "", receiverUrl: receiver.url }),
		);

		const response = await postSignedStripeWebhook(
			stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_e2e_shutdown",
					charge: "ch_e2e_shutdown",
					latest_charge: "ch_e2e_shutdown",
					payment_intent: {
						id: "pi_e2e_shutdown",
						latest_charge: "ch_e2e_shutdown",
						metadata: { billingAccountId: "integration_user" },
					},
				}),
				"evt_e2e_shutdown",
			),
		);
		expect(response.status).toBe(200);
		await waitForHeldRequest(hold.requestStarted);

		service.sendSignal("SIGTERM");
		hold.release(200);
		const exitCode = await Promise.race([service.exited, Bun.sleep(5000).then(() => null)]);
		expect(exitCode).toBe(0);
		await expectProjectionSucceeded("stripe:payment:pi_e2e_shutdown:projection");
	});

	it("exits cleanly on SIGTERM when idle", async () => {
		service = await startBillingService(
			e2eServiceEnv({ postgresUri: process.env.POSTGRES_URI ?? "" }),
		);

		const startedAt = Date.now();
		service.sendSignal("SIGTERM");
		const exitCode = await Promise.race([service.exited, Bun.sleep(5000).then(() => null)]);

		expect(exitCode).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(5000);
	});
});

async function createPostgresProxy(): Promise<TcpProxy> {
	const parsed = new URL(process.env.POSTGRES_URI ?? "");
	return await createTcpProxy({
		host: parsed.hostname,
		port: Number(parsed.port),
	});
}

function proxiedPostgresUri(activeProxy: TcpProxy): string {
	const parsed = new URL(process.env.POSTGRES_URI ?? "");
	parsed.hostname = activeProxy.host;
	parsed.port = String(activeProxy.port);
	return parsed.toString();
}

async function expectStatus(path: string, status: number): Promise<void> {
	const response = await service?.request(path);
	expect(response?.status).toBe(status);
}

async function waitForStatus(path: string, status: number): Promise<void> {
	await waitFor(
		async () => (await service?.request(path))?.status === status,
		`${path} status ${status}`,
	);
}

async function expectAuthenticatedProjectStatus(status: number, errorCode?: string): Promise<void> {
	const response = await service?.request("/v1/billing-accounts/e2e-auth-probe/entitlements", {
		headers: { authorization: `Bearer ${e2eApiKey}` },
	});
	expect(response?.status).toBe(status);
	if (errorCode !== undefined) {
		expect(await response?.json()).toMatchObject({ error: { code: errorCode } });
	}
}

async function postSignedStripeWebhook(event: Record<string, unknown>): Promise<Response> {
	if (service === null) {
		throw new Error("Billing service is not running");
	}
	const payload = JSON.stringify(event);
	return await service.request("/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": signStripeWebhook(payload),
		},
		body: payload,
	});
}

async function expectProjectionSucceeded(idempotencyKey: string): Promise<void> {
	await waitFor(async () => {
		const rows = await sql<
			{ status: string; locked_at: string | null; locked_by: string | null }[]
		>`
			SELECT status, locked_at::text AS locked_at, locked_by
			FROM projection_sync_jobs
			WHERE idempotency_key = ${idempotencyKey}
		`;
		return (
			rows.length === 1 &&
			rows[0].status === "succeeded" &&
			rows[0].locked_at === null &&
			rows[0].locked_by === null
		);
	}, `projection ${idempotencyKey} succeeded`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function waitForHeldRequest(requestStarted: Promise<unknown>): Promise<void> {
	const timeout = Symbol("timeout");
	const result = await Promise.race([requestStarted, Bun.sleep(5000).then(() => timeout)]);
	if (result === timeout) {
		throw new Error(`Timed out waiting for held projection request\n${service?.logs() ?? ""}`);
	}
}
