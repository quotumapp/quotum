import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { MerchantSql } from "../../src/platform/database";
import {
	ABSOLUTE_MS,
	CSRF_COOKIE,
	IDLE_MS,
	SESSION_COOKIE,
	SESSION_TOUCH_MS,
} from "../../src/platform/security";
import { MerchantStore } from "../../src/platform/store";
import { MerchantBrowser, merchantFixture, testConfig } from "./fixture";

const start = new Date();
const f = merchantFixture({ now: () => start });
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

async function session() {
	const browser = new MerchantBrowser(f);
	await browser.signup();
	const request = new Request(`${testConfig.origin}/api/platform/session`, {
		headers: { cookie: `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE)}` },
	});
	return { browser, request };
}
function observingSql(onQuery: (query: string, rows: object[]) => Promise<void>): MerchantSql {
	const query: MerchantSql = Object.assign(
		async <Rows extends object[]>(
			strings: TemplateStringsArray,
			...values: Parameters<MerchantSql>[1][]
		) => {
			const rows = await f.sql<Rows>(strings, ...values);
			await onQuery(strings.join("?"), rows);
			return rows;
		},
		{ begin: f.sql.begin, instances: f.sql.instances },
	);
	return query;
}

describe("session activity writes", () => {
	it("reads without writing inside the interval and reports persisted idle expiry", async () => {
		const { browser, request } = await session();
		const [before] = await f.sql`SELECT xmin::text,last_seen_at FROM platform_merchant_sessions`;
		f.advance(SESSION_TOUCH_MS - 1);
		await Promise.all(Array.from({ length: 25 }, () => f.store.authenticate(request)));
		const body = await browser.json("/api/platform/session");
		const [after] = await f.sql`SELECT xmin::text,last_seen_at FROM platform_merchant_sessions`;
		expect(after).toEqual(before);
		expect(body.idleExpiresAt).toBe(new Date(start.getTime() + IDLE_MS).toISOString());
		f.advance(1);
		expect((await f.store.authenticate(request)).lastSeenAt.getTime()).toBe(
			start.getTime() + SESSION_TOUCH_MS,
		);
	});
	it("writes once when concurrent stores cross the interval boundary", async () => {
		const { request } = await session();
		f.advance(SESSION_TOUCH_MS);
		let updates = 0;
		const sql = observingSql(async (query, rows) => {
			if (query.startsWith("UPDATE platform_merchant_sessions")) updates += rows.length;
		});
		const stores = Array.from({ length: 8 }, () => new MerchantStore(sql, testConfig, f.store.now));
		const rows = await Promise.all(
			Array.from({ length: 80 }, (_, i) => stores[i % stores.length].authenticate(request)),
		);
		expect(updates).toBe(1);
		for (const row of rows)
			expect(row.lastSeenAt.getTime()).toBe(start.getTime() + SESSION_TOUCH_MS);
	});
	for (const change of ["revoked", "rotated", "disabled", "absolute", "idle"] as const) {
		it(`rejects ${change} sessions on the read path`, async () => {
			const { request } = await session();
			if (change === "revoked")
				await f.sql`UPDATE platform_merchant_sessions SET revoked_at=${start}`;
			if (change === "rotated")
				await f.sql`UPDATE platform_merchant_sessions SET token_hash='rotated'`;
			if (change === "disabled") await f.sql`UPDATE platform_principals SET status='suspended'`;
			if (change === "absolute")
				await f.sql`UPDATE platform_merchant_sessions SET absolute_expires_at=${start}`;
			if (change === "idle") f.advance(IDLE_MS);
			await expect(f.store.authenticate(request)).rejects.toMatchObject({
				code: "SESSION_EXPIRED",
			});
		});
	}
	for (const change of ["revoked", "rotated", "disabled"] as const) {
		it(`rejects ${change} state committed between the read and conditional update`, async () => {
			const { request } = await session();
			f.advance(SESSION_TOUCH_MS);
			let changed = false;
			const sql = observingSql(async (query) => {
				if (!changed && query.startsWith("SELECT s.*")) {
					changed = true;
					if (change === "revoked")
						await f.sql`UPDATE platform_merchant_sessions SET revoked_at=${f.store.now()}`;
					if (change === "rotated")
						await f.sql`UPDATE platform_merchant_sessions SET token_hash='rotated'`;
					if (change === "disabled") await f.sql`UPDATE platform_principals SET status='suspended'`;
				}
			});
			const store = new MerchantStore(sql, testConfig, f.store.now);
			await expect(store.authenticate(request)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
			expect(changed).toBe(true);
		});
	}
	it("keeps idle and absolute expiry strict without extending them by the write interval", async () => {
		const { request } = await session();
		f.advance(SESSION_TOUCH_MS - 1);
		await f.store.authenticate(request);
		// Unpersisted activity does not count: idle expiry is measured from the last write.
		f.advance(IDLE_MS - (SESSION_TOUCH_MS - 1));
		await expect(f.store.authenticate(request)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
		await f.sql`UPDATE platform_merchant_sessions SET last_seen_at=${new Date(start.getTime() + ABSOLUTE_MS)}`;
		f.advance(ABSOLUTE_MS - IDLE_MS);
		await expect(f.store.authenticate(request)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
	});
	it("enforces CSRF on mutations without a session write", async () => {
		const { browser, request } = await session();
		const bad = new Request(request, { method: "POST" });
		await expect(f.store.authenticate(bad)).rejects.toMatchObject({ code: "CSRF_REJECTED" });
		const valid = new Request(request, {
			method: "POST",
			headers: {
				cookie: `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE)}; ${CSRF_COOKIE}=${browser.cookies.get(CSRF_COOKIE)}`,
			},
		});
		expect((await f.store.authenticate(valid)).sessionId).toBeTruthy();
	});
});
