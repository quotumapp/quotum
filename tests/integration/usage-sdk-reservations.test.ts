import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const lane = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

lane("public SDK reservation contract", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		await context.repository.usageApi.createAccount(project, "payer");
		await context.repository.grantAllocation(project, {
			billingAccountId: "payer",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "sdk-test",
		});
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("holds an upper bound and commits one immutable confirmation receipt with exact recovery", async () => {
		const api = context.repository.usageApi;
		const reserve = {
			billingAccountId: "payer",
			featureId: "model_tokens",
			value: "100",
			operationId: "job",
		};
		const held = await api.reserve(project, reserve);
		expect(held).toMatchObject({
			operation: "reserve",
			allowed: true,
			status: "active",
			balance: { held: "0.5", available: "9.5" },
		});
		if (!held.allowed) throw new Error("Expected a hold");
		expect(await api.reserve(project, { ...reserve, value: "0100.000" })).toEqual(held);
		await expect(api.reserve(project, { ...reserve, value: "101" })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		const confirm = {
			billingAccountId: "payer",
			reservationId: held.reservationId,
			value: "60",
			operationId: "job",
		};
		const result = await api.confirm(project, confirm);
		expect(result).toMatchObject({
			allowed: true,
			operation: "confirm",
			status: "confirmed",
			balance: { held: "0", consumed: "0.3", available: "9.7" },
			rated: { value: "0.3" },
		});
		if (!result.allowed) throw new Error("Expected confirmation");
		expect(await api.confirm(project, confirm)).toEqual(result);
		expect(
			(
				await context.repository.getUsageOperation(project, {
					billingAccountId: "payer",
					operation: "confirm",
					operationId: "job",
				})
			).outcome,
		).toEqual(result);
		const receipt = await api.getReceipt(project, {
			billingAccountId: "payer",
			receiptId: result.receiptId,
		});
		expect(receipt).toMatchObject({
			operation: "confirm",
			reservationId: held.reservationId,
			usage: { value: "60" },
		});
		const again = await api.confirm(project, { ...confirm, operationId: "new-confirm" });
		expect(again).toEqual({ ...result, operationId: "new-confirm" });
		expect(
			await api.getReceipt(project, { billingAccountId: "payer", receiptId: result.receiptId }),
		).toEqual(receipt);
		expect(await api.getReservation(project, confirm)).toMatchObject({
			status: "confirmed",
			confirmedValue: "60",
			receiptId: result.receiptId,
		});
		expect(await api.release(project, confirm)).toMatchObject({
			status: "confirmed",
			operation: "release",
			finalizedAt: expect.any(String),
		});
		const [count] =
			await context.sql`SELECT count(*)::int AS events FROM usage_events WHERE project_id = ${project.projectInstanceId}`;
		expect(count.events).toBe(1);
	});

	it("enforces the ceiling and terminal states without creating usage for a release", async () => {
		const api = context.repository.usageApi;
		const held = await api.reserve(project, {
			billingAccountId: "payer",
			featureId: "model_tokens",
			value: "100",
			operationId: "hold",
		});
		if (!held.allowed) throw new Error("Expected a hold");
		const input = {
			billingAccountId: "payer",
			reservationId: held.reservationId,
			operationId: "finalize",
		};
		await expect(api.confirm(project, { ...input, value: "101" })).rejects.toMatchObject({
			code: "RESERVATION_QUANTITY_EXCEEDED",
		});
		expect((await api.getReservation(project, input)).status).toBe("active");
		const released = await api.release(project, input);
		expect(released.status).toBe("released");
		expect(released).not.toHaveProperty("allowed");
		expect(await api.release(project, input)).toEqual(released);
		await expect(api.confirm(project, { ...input, value: "1" })).rejects.toMatchObject({
			code: "RESERVATION_RELEASED",
		});
		const [count] =
			await context.sql`SELECT count(*)::int AS events FROM usage_events WHERE project_id = ${project.projectInstanceId}`;
		expect(count.events).toBe(0);
	});

	it("reads logical expiry without maintenance and frees capacity for the next authorization", async () => {
		const api = context.repository.usageApi;
		const held = await api.reserve(project, {
			billingAccountId: "payer",
			featureId: "model_tokens",
			value: "2000",
			operationId: "expired",
		});
		if (!held.allowed) throw new Error("Expected a hold");
		await context.sql`UPDATE reservations SET effective_at = now() - interval '2 minutes', created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE project_id = ${project.projectInstanceId} AND id = ${held.reservationId}`;
		const input = {
			billingAccountId: "payer",
			reservationId: held.reservationId,
			operationId: "expired-confirm",
		};
		const state = await api.getReservation(project, input);
		expect(state.status).toBe("expired");
		expect(state.finalizedAt).toBe(state.expiresAt);
		expect(await api.confirm(project, { ...input, value: "1" })).toMatchObject({
			allowed: false,
			reason: "reservation_expired",
			status: "expired",
		});
		expect(
			await api.reserve(project, {
				billingAccountId: "payer",
				featureId: "model_tokens",
				value: "2000",
				operationId: "replacement",
			}),
		).toMatchObject({ allowed: true });
	});

	it("serializes confirm/release and concurrent duplicates to one terminal transition", async () => {
		const api = context.repository.usageApi;
		const input = {
			billingAccountId: "payer",
			featureId: "model_tokens",
			value: "100",
			operationId: "race",
		};
		const attempts = await Promise.allSettled([
			api.reserve(project, input),
			api.reserve(project, input),
		]);
		const accepted = attempts.find((result) => result.status === "fulfilled");
		if (accepted?.status !== "fulfilled" || !accepted.value.allowed)
			throw new Error("Expected one accepted hold");
		const reservationId = accepted.value.reservationId;
		await Promise.allSettled([
			api.confirm(project, {
				billingAccountId: "payer",
				reservationId,
				value: "50",
				operationId: "race",
			}),
			api.release(project, { billingAccountId: "payer", reservationId, operationId: "race" }),
		]);
		const state = await api.getReservation(project, { billingAccountId: "payer", reservationId });
		expect(["confirmed", "released"]).toContain(state.status);
		const [count] =
			await context.sql`SELECT count(*)::int AS events FROM usage_events WHERE project_id = ${project.projectInstanceId} AND reservation_id = ${reservationId}`;
		expect(count.events).toBe(state.status === "confirmed" ? 1 : 0);
	});

	it("publishes compact HTTP shapes and keeps account, entity, and project reads isolated", async () => {
		const { app, authHeaders } = createIntegrationApp(context);
		const path = "/v1/billing-accounts/payer/usage/reservations";
		const post = (body: unknown, account = "payer") =>
			testRequest(app, path.replace("payer", account), {
				method: "POST",
				headers: { ...authHeaders(), "idempotency-key": "http" },
				body: JSON.stringify(body),
			});
		expect((await post({ featureId: "model_tokens", value: "100" }, "missing")).status).toBe(404);
		for (const body of [
			{ featureKey: "model_tokens", quantity: "100" },
			{ featureId: "model_tokens", value: "100", metadata: {} },
		])
			expect((await post(body)).status).toBe(400);
		await context.repository.controlsEnterprise.createEntity(project, {
			billingAccountId: "payer",
			externalId: "work",
			kind: "workspace",
		});
		const response = await post({ featureId: "model_tokens", value: "100", entityId: "work" });
		expect(response.status).toBe(200);
		const held = (await response.json()).data;
		expect(held).not.toHaveProperty("deductions");
		expect(
			(await testRequest(app, `${path}/${held.reservationId}`, { headers: authHeaders() })).status,
		).toBe(200);
		expect(
			(await testRequest(app, `${path}/${held.reservationId}`, { headers: authHeaders("globex") }))
				.status,
		).toBe(404);
		const confirm = await testRequest(app, `${path}/${held.reservationId}/confirm`, {
			method: "POST",
			headers: { ...authHeaders(), "idempotency-key": "http" },
			body: JSON.stringify({ value: "50" }),
		});
		expect(confirm.status).toBe(200);
		const result = (await confirm.json()).data;
		expect(result).toMatchObject({ allowed: true, entityId: "work" });
		await expect(
			context.repository.usageApi.getReceipt(project, {
				billingAccountId: "payer",
				receiptId: result.receiptId,
			}),
		).rejects.toMatchObject({ code: "RECEIPT_NOT_FOUND" });
		expect(
			await context.repository.usageApi.getReceipt(project, {
				billingAccountId: "payer",
				receiptId: result.receiptId,
				entityId: "work",
			}),
		).toMatchObject({ operation: "confirm" });
	});
});
