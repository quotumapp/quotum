import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decodeUsageCursor, encodeUsageCursor } from "../../src/billing/insights";
import { receiptId } from "../../src/db/repository/usage-receipts";
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

localDescribe("usage event paging and receipt identifiers", () => {
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

	function http() {
		const { app, authHeaders } = createIntegrationApp(context);
		return (path: string, init: RequestInit = {}) =>
			testRequest(app, path, { ...init, headers: { ...authHeaders(), ...init.headers } });
	}

	async function fund(billingAccountId: string): Promise<void> {
		await context.repository.usageApi.createAccount(project, billingAccountId);
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "1000",
			sourceKind: "credit_grant",
			sourceKey: `${billingAccountId}:grant`,
		});
	}

	async function consume(billingAccountId: string, count: number): Promise<void> {
		await Promise.all(
			Array.from({ length: count }, (_, index) =>
				context.repository.consumeUsage(project, {
					billingAccountId,
					featureKey: "model_tokens",
					quantity: "10",
					idempotencyKey: `${billingAccountId}-${index}`,
				}),
			),
		);
	}

	/**
	 * Production traffic across accounts records several events in one millisecond. Reproduce that by
	 * giving every event a microsecond-distinct `recorded_at` inside one of two milliseconds, kept in
	 * the second the events were written in so no row changes partition.
	 */
	async function crowdIntoTwoMilliseconds(): Promise<string[]> {
		const rows = await context.sql<Array<{ id: string }>>`
			SELECT id::text AS id FROM usage_events ORDER BY recorded_at, id`;
		for (const [index, row] of rows.entries()) {
			const millisecond = index < rows.length / 2 ? 123 : 456;
			await context.sql`
				UPDATE usage_events
				SET recorded_at = date_trunc('second', (SELECT min(recorded_at) FROM usage_events))
					+ (${millisecond} * interval '1 millisecond') + (${100 + index * 7} * interval '1 microsecond')
				WHERE id = ${row.id}::uuid`;
		}
		const [spread] = await context.sql<Array<{ milliseconds: string }>>`
			SELECT count(DISTINCT date_trunc('milliseconds', recorded_at))::text AS milliseconds
			FROM usage_events`;
		expect(spread?.milliseconds).toBe("2");
		return rows.map((row) => row.id);
	}

	async function pageThrough(
		get: ReturnType<typeof http>,
		path: string,
		limit: number,
	): Promise<string[]> {
		const seen: string[] = [];
		// The crowded events sit up to a second ahead of the clock, so the range must reach past now.
		const to = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
		let cursor: string | null = null;
		for (let page = 0; page < 100; page++) {
			const response = await get(
				`${path}?limit=${limit}&to=${to}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
			);
			expect(response.status).toBe(200);
			const body = await response.json();
			for (const item of body.data) seen.push(item.id);
			cursor = body.pagination.nextCursor;
			if (cursor === null) return seen;
		}
		throw new Error("paging did not finish");
	}

	it("lists every event of an account once when a page ends inside one millisecond", async () => {
		await fund("paging");
		await consume("paging", 48);
		const expected = await crowdIntoTwoMilliseconds();
		const get = http();
		for (const limit of [1, 2, 3, 7, 50]) {
			const seen = await pageThrough(get, "/v1/billing-accounts/paging/usage/events", limit);
			expect(seen).toHaveLength(expected.length);
			expect(new Set(seen)).toEqual(new Set(expected));
		}
	}, 120_000);

	it("lists every event of the project once across accounts", async () => {
		for (const account of ["paging_a", "paging_b", "paging_c"]) {
			await fund(account);
			await consume(account, 8);
		}
		const expected = await crowdIntoTwoMilliseconds();
		const get = http();
		for (const limit of [1, 4, 5, 24]) {
			const seen = await pageThrough(get, "/v1/admin/usage-events", limit);
			expect(seen).toHaveLength(expected.length);
			expect(new Set(seen)).toEqual(new Set(expected));
		}
	}, 120_000);

	it("carries the exact microsecond in the cursor and still resumes a millisecond cursor", async () => {
		await fund("cursor");
		await consume("cursor", 6);
		await crowdIntoTwoMilliseconds();
		const get = http();
		const to = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
		const events = `/v1/billing-accounts/cursor/usage/events?limit=2&to=${to}`;
		const first = await (await get(events)).json();
		const decoded = decodeUsageCursor(first.pagination.nextCursor);
		const [last] = await context.sql<Array<{ exact: string }>>`
			SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
			FROM usage_events WHERE id = ${first.data.at(-1).id}::uuid`;
		expect(decoded).toEqual({ recordedAt: last?.exact ?? "", id: first.data.at(-1).id });
		expect(decoded?.recordedAt).toMatch(/\.\d{6}Z$/);

		// A cursor issued before microseconds were carried names the truncated millisecond.
		const legacy = encodeUsageCursor({
			recordedAt: first.data.at(-1).recordedAt,
			id: first.data.at(-1).id,
		});
		const resumed = await get(`${events}&cursor=${encodeURIComponent(legacy)}`);
		expect(resumed.status).toBe(200);
		expect((await resumed.json()).data).toBeArray();
	}, 120_000);

	it("answers a receipt identifier that names no real instant with 400, never 500", async () => {
		await fund("receipts");
		const get = http();
		const id = "1f524c44-64c8-4c18-bceb-234d84a51aca";
		for (const recordedAt of [
			"2026-02-31T00:00:00Z",
			"2026-02-29T00:00:00Z",
			"2026-04-31T00:00:00Z",
			"2026-13-01T00:00:00Z",
			"0000-10-05T10:00:00Z",
			"2026-10-05T24:00:00Z",
			"2026-10-05T10:00:00+23:59",
			"2026-10-05T10:00:00-16:00",
		]) {
			for (const suffix of ["", "/deductions"]) {
				const response = await get(
					`/v1/billing-accounts/receipts/usage/receipts/${receiptId(id, recordedAt)}${suffix}`,
				);
				expect(response.status).toBe(400);
				expect((await response.json()).error.code).toBe("INVALID_REQUEST");
			}
		}
		for (const recordedAt of [
			"2028-02-29T00:00:00Z",
			"2026-10-05 10:00:00.123456+00",
			"2026-10-05T10:00:00+15:59",
			"2026-10-05T10:00:00-0530",
		]) {
			const response = await get(
				`/v1/billing-accounts/receipts/usage/receipts/${receiptId(id, recordedAt)}`,
			);
			expect(response.status).toBe(404);
			expect((await response.json()).error.code).toBe("RECEIPT_NOT_FOUND");
		}
	});

	it("reads deductions of a real receipt and takes only plain decimal digits as the limit", async () => {
		await fund("deductions");
		const get = http();
		const consumed = await get("/v1/billing-accounts/deductions/usage/consume", {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": "deductions-1" },
			body: JSON.stringify({ featureId: "model_tokens", value: "10" }),
		});
		expect(consumed.status).toBe(200);
		const { receiptId: receipt } = (await consumed.json()).data;
		const path = `/v1/billing-accounts/deductions/usage/receipts/${receipt}/deductions`;
		expect((await get(`${path}?limit=1`)).status).toBe(200);
		expect((await get(path)).status).toBe(200);
		for (const limit of ["1e1", "0x10", "1.0", "%202", "0", "101", "-1"]) {
			const response = await get(`${path}?limit=${limit}`);
			expect(response.status).toBe(400);
			expect((await response.json()).error.code).toBe("INVALID_REQUEST");
		}
	});

	it("rejects a reservation quantity padded with whitespace", async () => {
		await fund("padded");
		const get = http();
		const reserve = (quantity: string, key: string) =>
			get("/v1/billing-accounts/padded/usage/reservations", {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": key },
				body: JSON.stringify({ featureKey: "model_tokens", quantity, expiresInSeconds: 300 }),
			});
		for (const [index, quantity] of [" 1 ", "1\n", "\t1", "1 "].entries()) {
			const response = await reserve(quantity, `padded-${index}`);
			expect(response.status).toBe(400);
			expect((await response.json()).error.code).toBe("INVALID_REQUEST");
		}
		expect((await reserve("1", "padded-ok")).status).toBe(200);
	});
});
