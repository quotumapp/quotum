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
		for (const field of ["reason", "deductions", "rateCard", "usageEventId"])
			expect(first).not.toHaveProperty(field);
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
});
