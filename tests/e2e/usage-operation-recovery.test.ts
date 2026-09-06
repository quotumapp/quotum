import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type BillingDatabaseConnection,
	createBillingDatabaseConnection,
} from "../../src/db/client";
import { BillingRepository } from "../../src/db/repository";
import { BillingClient } from "../../src/sdk/client";
import { resetAndSeedIntegrationData } from "../integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../integration/helpers/metering-catalog";
import { integrationProjectContext } from "../integration/helpers/platform-fixture";
import { e2eApiKey, e2eServiceEnv } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { type BillingServiceProcess, startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);
let connection: BillingDatabaseConnection;
let service: BillingServiceProcess | null = null;
let postgresUri: string;

e2eDescribe("E2E usage operation recovery", () => {
	beforeEach(async () => {
		postgresUri = process.env.POSTGRES_URI ?? "";
		if (!postgresUri) throw new Error("POSTGRES_URI is required");
		connection = createBillingDatabaseConnection({ postgresUri });
		await resetAndSeedIntegrationData(connection.sql);
		const repository = new BillingRepository(connection.db as never);
		await publishAiCreditsCatalog(repository);
		await repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "http-recovery",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "e2e-recovery",
		});
		service = await startBillingService(e2eServiceEnv({ postgresUri }));
	});
	afterEach(async () => {
		await service?.stop();
		service = null;
		await connection?.sql.close();
	});

	it("recovers a dropped HTTP response after a full service restart using the backend SDK", async () => {
		if (service === null) throw new Error("Service not started");
		const baseUrl = service.baseUrl;
		const operationId = "job/restart:1";
		const controller = new AbortController();
		let committedOutcome: unknown;
		// Forward the real request, then lose the client response after the service has committed.
		const proxy = Bun.serve({
			port: 0,
			async fetch(request) {
				const response = await fetch(`${baseUrl}/v1/billing-accounts/http-recovery/usage/consume`, {
					method: "POST",
					headers: request.headers,
					body: await request.text(),
				});
				const payload = await response.json();
				committedOutcome = payload.data;
				controller.abort();
				return Response.json(payload, { status: response.status });
			},
		});
		try {
			await expect(
				fetch(`http://127.0.0.1:${proxy.port}`, {
					method: "POST",
					signal: controller.signal,
					headers: {
						Authorization: `Bearer ${e2eApiKey}`,
						"Content-Type": "application/json",
						"Idempotency-Key": operationId,
					},
					body: JSON.stringify({ featureKey: "model_tokens", quantity: "100" }),
				}),
			).rejects.toThrow();
		} finally {
			proxy.stop(true);
		}
		expect(committedOutcome).toMatchObject({ allowed: true, walletQuantity: "0.5" });
		await service.stop();
		service = await startBillingService(e2eServiceEnv({ postgresUri }));
		const client = new BillingClient({ baseUrl: service.baseUrl, apiKey: e2eApiKey });
		const recovered = await client.usage.getOperation({
			billingAccountId: "http-recovery",
			operation: "consume",
			operationId,
		});
		expect(recovered).toMatchObject({
			status: "completed",
			operationId,
			outcome: { allowed: true, walletQuantity: "0.5" },
		});
		const replay = await client.usage.consume(
			{ billingAccountId: "http-recovery", featureKey: "model_tokens", quantity: "100.00" },
			operationId,
		);
		expect(committedOutcome).toEqual(replay);
		await expect(
			client.usage.consume(
				{ billingAccountId: "http-recovery", featureKey: "model_tokens", quantity: "101" },
				operationId,
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
		const [state] =
			await connection.sql`SELECT (SELECT count(*)::int FROM usage_events) AS events, (SELECT count(*)::int FROM client_idempotency_claims) AS claims, (SELECT sum(consumed_quantity)::text FROM balance_allocations) AS consumed`;
		expect(state).toEqual({ events: 1, claims: 1, consumed: "0.500000000" });
	});
});
