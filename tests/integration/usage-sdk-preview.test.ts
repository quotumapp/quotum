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

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;
localDescribe("public usage SDK contract", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("creates an account once under concurrency without overwriting an existing record", async () => {
		const accounts = await Promise.all(
			Array.from({ length: 8 }, () => context.repository.usageApi.createAccount(project, "payer")),
		);
		expect(
			accounts.every((account) => JSON.stringify(account) === JSON.stringify(accounts[0])),
		).toBe(true);
		await context.sql`UPDATE customers SET email = 'owner@example.test', metadata = '{"kept":true}'::jsonb WHERE project_id = ${project.projectInstanceId} AND billing_account_id = 'payer'`;
		const [before] =
			await context.sql`SELECT email, metadata, updated_at FROM customers WHERE project_id = ${project.projectInstanceId} AND billing_account_id = 'payer'`;
		expect(await context.repository.usageApi.createAccount(project, "payer")).toEqual(accounts[0]);
		const [after] =
			await context.sql`SELECT email, metadata, updated_at FROM customers WHERE project_id = ${project.projectInstanceId} AND billing_account_id = 'payer'`;
		expect(after).toEqual(before);
		await expect(context.repository.usageApi.getAccount(project, "Payer")).rejects.toMatchObject({
			code: "BILLING_ACCOUNT_NOT_FOUND",
		});
	});

	it("requires explicit accounts and rejects legacy names and metadata at the HTTP boundary", async () => {
		const { app, authHeaders } = createIntegrationApp(context);
		const post = (body: unknown) =>
			testRequest(app, "/v1/billing-accounts/new/usage/consume", {
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json", "idempotency-key": "job" },
				body: JSON.stringify(body),
			});
		expect((await post({ featureId: "model_tokens", value: "1" })).status).toBe(404);
		for (const body of [
			{ featureKey: "model_tokens", quantity: "1" },
			{ featureId: "model_tokens", value: "1", metadata: {} },
			{ featureId: "model_tokens", value: "1", filters: {} },
		])
			expect((await post(body)).status).toBe(400);
		await expect(
			context.repository.controlsEnterprise.createEntity(project, {
				billingAccountId: "new",
				externalId: "child",
				kind: "workspace",
			}),
		).rejects.toMatchObject({ code: "BILLING_ACCOUNT_NOT_FOUND" });
		const created = await testRequest(app, "/v1/billing-accounts/new", {
			method: "PUT",
			headers: authHeaders(),
		});
		expect(created.status).toBe(200);
		expect((await created.json()).data).toMatchObject({ id: "new", createdAt: expect.any(String) });
		const denied = await post({ featureId: "model_tokens", value: "1" });
		expect(denied.status).toBe(200);
		const result = (await denied.json()).data;
		expect(result).toMatchObject({
			allowed: false,
			reason: "insufficient_balance",
			operationId: "job",
		});
		expect(result).not.toHaveProperty("receiptId");
		expect(result).not.toHaveProperty("recordedAt");
	});

	it("persists compact outcomes and immutable receipts and pages deductions in the exact scope", async () => {
		await context.repository.usageApi.createAccount(project, "payer");
		await context.repository.controlsEnterprise.createEntity(project, {
			billingAccountId: "payer",
			externalId: "workspace",
			kind: "workspace",
		});
		for (const sourceKey of ["one", "two"])
			await context.repository.grantAllocation(project, {
				billingAccountId: "payer",
				featureKey: "ai_credits",
				quantity: "0.5",
				sourceKind: "credit_grant",
				sourceKey,
			});
		const input = {
			billingAccountId: "payer",
			entityId: "workspace",
			featureId: "model_tokens",
			value: "150",
			operationId: "job/one",
		};
		const first = await context.repository.usageApi.consume(project, input);
		expect(first.allowed).toBe(true);
		if (!first.allowed) throw new Error("Expected allowed consumption");
		expect(first).toMatchObject({
			usage: { value: "150", unit: "token" },
			rated: { value: "0.75", featureId: "ai_credits" },
			balance: { available: "0.25" },
		});
		for (const field of ["reason", "deductions", "rateCard"])
			expect(first).not.toHaveProperty(field);
		// The usage event is returned so the consume can be corrected (owner decision, 2026-10-02).
		expect(typeof first.usageEventId).toBe("string");
		expect(first.balance).not.toHaveProperty("breakdown");
		const scope = { billingAccountId: "payer", entityId: "workspace", receiptId: first.receiptId };
		const receipt = await context.repository.usageApi.getReceipt(project, scope);
		expect(receipt).toMatchObject({
			...scope,
			operationId: "job/one",
			deductionCount: 2,
			usage: first.usage,
			balance: first.balance,
		});
		const page = await context.repository.usageApi.listReceiptDeductions(project, {
			...scope,
			limit: 1,
		});
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBeString();
		const last = await context.repository.usageApi.listReceiptDeductions(project, {
			...scope,
			limit: 1,
			cursor: page.nextCursor ?? undefined,
		});
		expect(last.items).toHaveLength(1);
		expect(last.nextCursor).toBeNull();
		await expect(
			context.repository.usageApi.getReceipt(project, { ...scope, entityId: undefined }),
		).rejects.toMatchObject({ code: "RECEIPT_NOT_FOUND" });
		await expect(
			context.repository.usageApi.listReceiptDeductions(project, { ...scope, cursor: "bad" }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			context.repository.usageApi.listReceiptDeductions(project, { ...scope, limit: 101 }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await context.repository.usageApi.consume(project, {
			...input,
			operationId: "later",
			value: "1",
		});
		expect(await context.repository.usageApi.getReceipt(project, scope)).toEqual(receipt);
		expect(
			await context.repository.usageApi.consume(project, { ...input, value: "000150.000" }),
		).toEqual(first);
		const lookup = await context.repository.getUsageOperation(project, {
			billingAccountId: "payer",
			entityId: "workspace",
			operation: "consume",
			operationId: "job/one",
		});
		expect(lookup).toMatchObject({ status: "completed", outcome: first });
		await expect(
			context.repository.getUsageOperation(project, {
				billingAccountId: "payer",
				operation: "consume",
				operationId: "job/one",
			}),
		).rejects.toMatchObject({ code: "OPERATION_NOT_FOUND" });
		await expect(
			context.repository.usageApi.consume(project, { ...input, value: "151" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});

	it("returns the usage event a correction needs with a compact consume", async () => {
		await context.repository.grantAllocation(project, {
			billingAccountId: "payer",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "seed",
		});
		const { app, authHeaders } = createIntegrationApp(context);
		const headers = { ...authHeaders(), "content-type": "application/json" };
		const consumed = await testRequest(app, "/v1/billing-accounts/payer/usage/consume", {
			method: "POST",
			headers: { ...headers, "idempotency-key": "correctable" },
			body: JSON.stringify({ featureId: "model_tokens", value: "100" }),
		});
		expect(consumed.status).toBe(200);
		const result = (await consumed.json()).data;
		expect(result.allowed).toBe(true);
		expect(typeof result.usageEventId).toBe("string");
		const available = async () =>
			(await context.repository.getMeteringBalance(project, "payer", "ai_credits")).available;
		const spent = await available();
		expect(spent).not.toBe("10");

		const receipt = await testRequest(
			app,
			`/v1/billing-accounts/payer/usage/receipts/${result.receiptId}`,
			{ headers: authHeaders() },
		);
		expect((await receipt.json()).data.usageEventId).toBe(result.usageEventId);

		// The usage event and its recorded time are all a correction names.
		const corrected = await testRequest(
			app,
			`/v1/billing-accounts/payer/usage/events/${result.usageEventId}/corrections`,
			{
				method: "POST",
				headers: {
					...headers,
					"idempotency-key": "correctable:refund",
					"x-billing-actor": "support@acme.test",
				},
				body: JSON.stringify({
					originalRecordedAt: result.recordedAt,
					quantity: "100",
					reason: "refund",
				}),
			},
		);
		expect(corrected.status).toBe(200);
		expect(await available()).toBe("10");
	});

	it("concurrent delivery records one billing effect and retains the original outcome", async () => {
		await context.repository.grantAllocation(project, {
			billingAccountId: "payer",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "seed",
		});
		const input = {
			billingAccountId: "payer",
			featureId: "model_tokens",
			value: "100",
			operationId: "concurrent",
		};
		const attempts = await Promise.allSettled(
			Array.from({ length: 6 }, () => context.repository.usageApi.consume(project, input)),
		);
		const first = await context.repository.usageApi.consume(project, input);
		for (const attempt of attempts) {
			if (attempt.status === "fulfilled") expect(attempt.value).toEqual(first);
			else expect(attempt.reason).toMatchObject({ code: "OPERATION_IN_PROGRESS" });
		}
		const [row] =
			await context.sql`SELECT count(*)::int AS events FROM usage_events WHERE project_id = ${project.projectInstanceId}`;
		expect(row?.events).toBe(1);
		const [claim] =
			await context.sql`SELECT recovery_version, outcome FROM client_idempotency_claims WHERE project_id = ${project.projectInstanceId}`;
		expect(claim).toMatchObject({ recovery_version: 2, outcome: first });
	});
	it("refuses a pre-cutover consume outcome without reusing its identity", async () => {
		await context.repository.grantAllocation(project, {
			billingAccountId: "payer",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "seed",
		});
		await context.repository.consumeUsage(project, {
			billingAccountId: "payer",
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "before-cutover",
			metadata: { legacyJob: "before-cutover" },
		});
		const { app, authHeaders } = createIntegrationApp(context);
		const lookup = await testRequest(
			app,
			"/v1/billing-accounts/payer/usage/operations/consume/before-cutover",
			{ headers: authHeaders() },
		);
		expect(lookup.status).toBe(409);
		expect((await lookup.json()).error.code).toBe("OPERATION_RESULT_EXPIRED");
		await expect(
			context.repository.usageApi.consume(project, {
				billingAccountId: "payer",
				featureId: "model_tokens",
				value: "100",
				operationId: "before-cutover",
			}),
		).rejects.toMatchObject({ code: "OPERATION_RESULT_EXPIRED" });
		const [row] = await context.sql`SELECT count(*)::int AS events FROM usage_events`;
		expect(row?.events).toBe(1);
	});
	it("replays retained results after the catalog disables the feature", async () => {
		await context.repository.grantAllocation(project, {
			billingAccountId: "payer",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "seed",
		});
		const input = {
			billingAccountId: "payer",
			featureId: "model_tokens",
			value: "100",
			operationId: "before-disable",
		};
		const first = await context.repository.usageApi.consume(project, input);
		await context.sql`UPDATE features SET active = false WHERE project_id = ${project.projectInstanceId} AND key = 'model_tokens'`;
		expect(await context.repository.usageApi.consume(project, input)).toEqual(first);
		await expect(
			context.repository.usageApi.consume(project, { ...input, operationId: "after-disable" }),
		).rejects.toMatchObject({ code: "FEATURE_NOT_FOUND" });
	});

	it("performs read-only boolean checks and validates feature-specific values", async () => {
		await context.sql`INSERT INTO features (project_id, key, name, kind, unit, credit_scale) VALUES (${project.projectInstanceId}, 'premium_access', 'Access', 'boolean', 'access', 0)`;
		await context.repository.usageApi.createAccount(project, "payer");
		const input = { billingAccountId: "payer", featureId: "premium_access" };
		expect(await context.repository.usageApi.check(project, input)).toMatchObject({
			kind: "boolean",
			allowed: false,
			reason: "not_entitled",
		});
		await expect(
			context.repository.usageApi.check(project, { ...input, value: "1" }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			context.repository.usageApi.check(project, { ...input, featureId: "model_tokens" }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		const [rows] =
			await context.sql`SELECT count(*)::int AS events FROM usage_events WHERE project_id = ${project.projectInstanceId}`;
		expect(rows?.events).toBe(0);
	});

	it("refuses usage on a feature that is not metered without calling it missing", async () => {
		await context.sql`INSERT INTO features (project_id, key, name, kind, unit, credit_scale) VALUES (${project.projectInstanceId}, 'premium_access', 'Access', 'boolean', 'access', 0)`;
		await context.repository.usageApi.createAccount(project, "payer");
		const { app, authHeaders } = createIntegrationApp(context);
		const send = async (method: string, path: string, body?: unknown, key?: string) => {
			const response = await testRequest(app, `/v1/billing-accounts/payer${path}`, {
				method,
				headers: {
					...authHeaders(),
					"content-type": "application/json",
					"x-billing-actor": "usage-test",
					...(key === undefined ? {} : { "idempotency-key": key }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const { error } = await response.json();
			return { status: response.status, code: error?.code, message: error?.message };
		};
		const unsupported = {
			status: 400,
			code: "FEATURE_OPERATION_UNSUPPORTED",
			message: "Feature premium_access is not metered: it has no balance and takes no usage",
		};
		const flag = { featureKey: "premium_access", quantity: "1" };

		expect(
			await send("POST", "/usage/consume", { featureId: "premium_access", value: "1" }, "c1"),
		).toEqual(unsupported);
		expect(await send("POST", "/usage/reservations", flag, "r1")).toEqual(unsupported);
		expect(await send("GET", "/balances/premium_access")).toEqual(unsupported);
		expect(
			await send("PUT", "/controls", {
				controlKind: "usage_limit",
				featureKey: "premium_access",
				limitValue: "5",
				interval: "day",
			}),
		).toEqual(unsupported);
		// A key that names no active feature is still the one that is not found.
		expect(
			await send("POST", "/usage/consume", { featureId: "no_such_feature", value: "1" }, "c2"),
		).toMatchObject({ status: 404, code: "FEATURE_NOT_FOUND" });
		expect(await send("GET", "/balances/no_such_feature")).toMatchObject({
			status: 404,
			code: "FEATURE_NOT_FOUND",
		});

		const [rows] = await context.sql`
			SELECT (SELECT count(*)::int FROM usage_events WHERE project_id = ${project.projectInstanceId}) AS events,
				(SELECT count(*)::int FROM reservations WHERE project_id = ${project.projectInstanceId}) AS holds,
				(SELECT count(*)::int FROM control_policies WHERE project_id = ${project.projectInstanceId}) AS controls`;
		expect(rows).toEqual({ events: 0, holds: 0, controls: 0 });
	});
});
