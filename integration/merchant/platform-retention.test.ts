import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { QuotumScheduledJob } from "../../src/composition/runtime-lifecycle";
import { PlatformRetentionSweep } from "../../src/platform/retention";
import { createBillingRuntime } from "../../src/runtime";
import { createIntegrationBillingEnv } from "../../tests/integration/helpers/local-postgres";
import { merchantFixture, testConfig } from "./fixture";

const fixture = merchantFixture();
const { sql } = fixture;
beforeEach(() => fixture.reset());
afterAll(() => fixture.sql.close());

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-10-01T12:00:00.000Z");

/** An instant `ms` before the sweep's clock; negative values are in its future. */
function ago(ms: number): Date {
	return new Date(NOW.getTime() - ms);
}

function sweep(options: { batchSize?: number; maxBatchesPerTable?: number } = {}) {
	return new PlatformRetentionSweep(sql, { now: () => NOW, ...options });
}

interface Actor {
	principalId: string;
	organizationId: string;
	sessionId: string;
}

async function actor(): Promise<Actor> {
	const [user] = await sql<{ id: string }[]>`
		INSERT INTO platform_auth_users(name,email,email_verified)
		VALUES('Retention Owner','retention-owner@example.com',true) RETURNING id`;
	const [principal] = await sql<{ id: string }[]>`
		INSERT INTO platform_principals(auth_user_id) VALUES(${user?.id ?? ""}) RETURNING id`;
	const [organization] = await sql<{ id: string }[]>`
		INSERT INTO platform_organizations(slug,name) VALUES('acme','Acme') RETURNING id`;
	const [session] = await sql<{ id: string }[]>`
		INSERT INTO platform_merchant_sessions(principal_id,token_hash,csrf_hash,auth_method,issuer,subject,absolute_expires_at)
		VALUES(${principal?.id ?? ""},'session-token','session-csrf','password','issuer','subject',${ago(-DAY)})
		RETURNING id`;
	if (!principal || !organization || !session) throw new Error("Seed failed");
	return { principalId: principal.id, organizationId: organization.id, sessionId: session.id };
}

async function rateLimit(key: string, resetAt: Date) {
	await sql`INSERT INTO platform_rate_limits(key_hash,count,reset_at) VALUES(${key},1,${resetAt})`;
}

async function link(token: string, expiresAt: Date, consumedAt: Date | null = null) {
	await sql`INSERT INTO platform_auth_links(token_hash,kind,expires_at,consumed_at)
		VALUES(${token},'reset',${expiresAt},${consumedAt})`;
}

async function idempotency(who: Actor, key: string, result: unknown, createdAt: Date) {
	await sql`INSERT INTO platform_idempotency(principal_id,key,request_hash,result,created_at)
		VALUES(${who.principalId},${key},'hash',${JSON.stringify(result)}::text::jsonb,${createdAt})`;
}

async function grant(
	who: Actor,
	label: string,
	input: { expiresAt: Date; consumedAt?: Date | null },
) {
	await sql`INSERT INTO platform_step_up_grants(session_id,organization_id,scope,action,target,return_to,expires_at,consumed_at)
		VALUES(${who.sessionId},${who.organizationId},'{}'::jsonb,${label},'target','/',${input.expiresAt},${input.consumedAt ?? null})`;
}

async function authorization(
	who: Actor,
	label: string,
	input: { createdAt: Date; expiresAt: Date; revokedAt?: Date | null },
): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO platform_mcp_authorizations(principal_id,organization_id,project_instance_id,client_id,client_name,created_at,expires_at,revoked_at)
		VALUES(${who.principalId},${who.organizationId},gen_random_uuid(),'quotum-claude-code',${label},${input.createdAt},${input.expiresAt},${input.revokedAt ?? null})
		RETURNING id`;
	if (!row) throw new Error("Seed failed");
	return row.id;
}

async function change(
	who: Actor,
	authorizationId: string,
	label: string,
	input: { status: string; createdAt: Date; expiresAt?: Date },
) {
	await sql`INSERT INTO platform_mcp_changes(authorization_id,principal_id,project_instance_id,request_key,request_hash,action,parameters,body,reason,preview,capability,step_up_action,sensitive,scope,status,created_at,expires_at)
		VALUES(${authorizationId},${who.principalId},gen_random_uuid(),${label},'hash','catalog.publish','[]'::jsonb,'{}'::jsonb,'Retention test','{}'::jsonb,'catalog.publish','catalog.publish',false,'{}'::jsonb,${input.status},${input.createdAt},${input.expiresAt ?? new Date(input.createdAt.getTime() + 15 * 60_000)})`;
}

async function labels(query: Promise<readonly object[]>, column: string) {
	return (await query).map((row) => String((row as Record<string, unknown>)[column])).sort();
}

describe("platform retention sweep", () => {
	it("deletes expired rows from every listed table and keeps live ones", async () => {
		const who = await actor();

		await rateLimit("rate-expired-old", ago(2 * DAY));
		await rateLimit("rate-expired-boundary", ago(1 * DAY));
		await rateLimit("rate-expired-recent", ago(DAY / 2));
		await rateLimit("rate-live", ago(-DAY / 24));

		await link("link-expired-old", ago(8 * DAY));
		await link("link-consumed-old", ago(-DAY), ago(8 * DAY));
		await link("link-expired-recent", ago(6 * DAY));
		await link("link-consumed-recent", ago(-DAY), ago(6 * DAY));
		await link("link-live", ago(-DAY));

		const stored = { state: "completed", response: { status: 200, body: { ok: true } } };
		await idempotency(who, "idem-completed-old", stored, ago(31 * DAY));
		await idempotency(who, "idem-result-old", { organizationId: "acme" }, ago(31 * DAY));
		await idempotency(who, "idem-completed-recent", stored, ago(29 * DAY));
		await idempotency(who, "idem-pending-old", { state: "pending" }, ago(31 * DAY));

		await grant(who, "grant-expired-old", { expiresAt: ago(8 * DAY) });
		await grant(who, "grant-consumed-old", { expiresAt: ago(-DAY), consumedAt: ago(8 * DAY) });
		await grant(who, "grant-expired-recent", { expiresAt: ago(6 * DAY) });
		await grant(who, "grant-consumed-recent", { expiresAt: ago(-DAY), consumedAt: ago(6 * DAY) });
		await grant(who, "grant-live", { expiresAt: ago(-DAY / 24) });

		const active = await authorization(who, "auth-active", {
			createdAt: ago(5 * DAY),
			expiresAt: ago(-25 * DAY),
		});
		await authorization(who, "auth-revoked-old", {
			createdAt: ago(40 * DAY),
			expiresAt: ago(-10 * DAY),
			revokedAt: ago(31 * DAY),
		});
		await authorization(who, "auth-expired-old", {
			createdAt: ago(70 * DAY),
			expiresAt: ago(31 * DAY),
		});
		await authorization(who, "auth-revoked-recent", {
			createdAt: ago(40 * DAY),
			expiresAt: ago(-10 * DAY),
			revokedAt: ago(29 * DAY),
		});
		await authorization(who, "auth-expired-recent", {
			createdAt: ago(60 * DAY),
			expiresAt: ago(29 * DAY),
		});
		const review = await authorization(who, "auth-needs-review", {
			createdAt: ago(70 * DAY),
			expiresAt: ago(40 * DAY),
		});
		const finished = await authorization(who, "auth-finished-old", {
			createdAt: ago(70 * DAY),
			expiresAt: ago(40 * DAY),
		});
		const recent = await authorization(who, "auth-recent-change", {
			createdAt: ago(70 * DAY),
			expiresAt: ago(40 * DAY),
		});

		for (const status of ["completed", "rejected", "cancelled", "expired", "stale", "failed"])
			await change(who, active, `change-${status}-old`, { status, createdAt: ago(31 * DAY) });
		await change(who, active, "change-completed-recent", {
			status: "completed",
			createdAt: ago(29 * DAY),
		});
		await change(who, active, "change-pending-abandoned", {
			status: "pending",
			createdAt: ago(40 * DAY),
		});
		await change(who, active, "change-pending-live", {
			status: "pending",
			createdAt: ago(DAY / 24),
			expiresAt: ago(-14 * 60_000),
		});
		await change(who, active, "change-applying-old", {
			status: "applying",
			createdAt: ago(40 * DAY),
		});
		await change(who, review, "change-needs-review-old", {
			status: "needs_review",
			createdAt: ago(40 * DAY),
		});
		await change(who, finished, "change-finished-old", {
			status: "completed",
			createdAt: ago(40 * DAY),
		});
		await change(who, recent, "change-finished-recent", {
			status: "completed",
			createdAt: ago(5 * DAY),
		});

		const result = await sweep().runOnce();

		expect(result.failures).toEqual([]);
		expect(result.capped).toEqual([]);
		expect(result.deleted).toEqual({
			platform_rate_limits: 1,
			platform_auth_links: 2,
			platform_idempotency: 2,
			platform_step_up_grants: 2,
			platform_mcp_changes: 8,
			platform_mcp_authorizations: 3,
		});
		expect(await labels(sql`SELECT key_hash FROM platform_rate_limits`, "key_hash")).toEqual([
			"rate-expired-boundary",
			"rate-expired-recent",
			"rate-live",
		]);
		expect(await labels(sql`SELECT token_hash FROM platform_auth_links`, "token_hash")).toEqual([
			"link-consumed-recent",
			"link-expired-recent",
			"link-live",
		]);
		expect(await labels(sql`SELECT key FROM platform_idempotency`, "key")).toEqual([
			"idem-completed-recent",
			"idem-pending-old",
		]);
		expect(await labels(sql`SELECT action FROM platform_step_up_grants`, "action")).toEqual([
			"grant-consumed-recent",
			"grant-expired-recent",
			"grant-live",
		]);
		expect(await labels(sql`SELECT request_key FROM platform_mcp_changes`, "request_key")).toEqual([
			"change-applying-old",
			"change-completed-recent",
			"change-finished-recent",
			"change-needs-review-old",
			"change-pending-live",
		]);
		expect(
			await labels(sql`SELECT client_name FROM platform_mcp_authorizations`, "client_name"),
		).toEqual([
			"auth-active",
			"auth-expired-recent",
			"auth-needs-review",
			"auth-recent-change",
			"auth-revoked-recent",
		]);
	});

	it("removes a grant in the sweep that removes its last proposal", async () => {
		const who = await actor();
		const grantId = await authorization(who, "auth-finished-old", {
			createdAt: ago(70 * DAY),
			expiresAt: ago(40 * DAY),
		});
		await change(who, grantId, "change-completed-old", {
			status: "completed",
			createdAt: ago(40 * DAY),
		});

		const first = await sweep().runOnce();

		expect(first.failures).toEqual([]);
		expect(first.deleted.platform_mcp_changes).toBe(1);
		expect(first.deleted.platform_mcp_authorizations).toBe(1);
		expect(await sql`SELECT id FROM platform_mcp_authorizations`).toHaveLength(0);
		expect(await sweep().runOnce()).toMatchObject({ failures: [], capped: [] });
	});

	it("leaves audit events, memberships, sessions and every unlisted table alone", async () => {
		const who = await actor();
		await sql`INSERT INTO platform_audit_events(principal_id,organization_id,action,created_at)
			VALUES(${who.principalId},${who.organizationId},'session.created',${ago(400 * DAY)})`;
		await sql`INSERT INTO platform_memberships(organization_id,principal_id,role,status,created_at)
			VALUES(${who.organizationId},${who.principalId},'Owner','removed',${ago(400 * DAY)})`;
		await sql`INSERT INTO platform_merchant_sessions(principal_id,token_hash,csrf_hash,auth_method,issuer,subject,created_at,last_seen_at,absolute_expires_at,revoked_at)
			VALUES(${who.principalId},'old-session','csrf','password','issuer','subject',${ago(400 * DAY)},${ago(400 * DAY)},${ago(399 * DAY)},${ago(399 * DAY)})`;
		await sql`INSERT INTO platform_auth_verifications(identifier,value,expires_at)
			VALUES('otp','123456',${ago(400 * DAY)})`;
		await rateLimit("rate-expired-old", ago(2 * DAY));
		const tables = [
			"platform_audit_events",
			"platform_memberships",
			"platform_merchant_sessions",
			"platform_auth_verifications",
			"platform_principals",
			"platform_organizations",
			"platform_auth_oauth_clients",
		];
		const count = async (table: string) => {
			const [row] = await fixture.client.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
			return row?.n;
		};
		const before = await Promise.all(tables.map(count));

		const result = await sweep().runOnce();

		expect(result.deleted.platform_rate_limits).toBe(1);
		expect(await Promise.all(tables.map(count))).toEqual(before);
	});

	it("deletes in bounded batches and continues on the next sweep", async () => {
		for (let index = 0; index < 5; index += 1) await rateLimit(`rate-old-${index}`, ago(3 * DAY));
		await rateLimit("rate-live", ago(-DAY));

		const first = await sweep({ batchSize: 2, maxBatchesPerTable: 2 }).runOnce();

		expect(first.deleted.platform_rate_limits).toBe(4);
		expect(first.capped).toEqual(["platform_rate_limits"]);
		expect(await sql`SELECT key_hash FROM platform_rate_limits`).toHaveLength(2);

		const second = await sweep({ batchSize: 2, maxBatchesPerTable: 2 }).runOnce();

		expect(second.deleted.platform_rate_limits).toBe(1);
		expect(second.capped).toEqual([]);
		expect(await labels(sql`SELECT key_hash FROM platform_rate_limits`, "key_hash")).toEqual([
			"rate-live",
		]);
	});

	it("lets concurrent sweeps split the work without errors or double deletes", async () => {
		const expired = 60;
		for (let index = 0; index < expired; index += 1)
			await rateLimit(`rate-old-${index}`, ago(3 * DAY));
		await rateLimit("rate-live", ago(-DAY));

		const results = await Promise.all([
			sweep({ batchSize: 7 }).runOnce(),
			sweep({ batchSize: 7 }).runOnce(),
			sweep({ batchSize: 7 }).runOnce(),
		]);

		for (const result of results) expect(result.failures).toEqual([]);
		const deleted = results.reduce((sum, result) => sum + result.deleted.platform_rate_limits, 0);
		const remaining =
			await sql`SELECT key_hash FROM platform_rate_limits WHERE key_hash <> 'rate-live'`;
		expect(deleted + remaining.length).toBe(expired);
		await sweep().runOnce();
		expect(await labels(sql`SELECT key_hash FROM platform_rate_limits`, "key_hash")).toEqual([
			"rate-live",
		]);
	});

	it("skips rows a request holds locked instead of waiting for them", async () => {
		const who = await actor();
		const grantId = await authorization(who, "auth-expired-old", {
			createdAt: ago(70 * DAY),
			expiresAt: ago(40 * DAY),
		});
		await rateLimit("rate-old", ago(2 * DAY));
		await rateLimit("rate-locked", ago(2 * DAY));

		await sql.begin(async (request) => {
			// What a proposal approval or a rate-limited request holds while it works.
			await request`SELECT id FROM platform_mcp_authorizations WHERE id=${grantId} FOR UPDATE`;
			await request`SELECT key_hash FROM platform_rate_limits WHERE key_hash='rate-locked' FOR UPDATE`;
			const result = await sweep().runOnce();
			expect(result.failures).toEqual([]);
			expect(result.deleted.platform_rate_limits).toBe(1);
			expect(result.deleted.platform_mcp_authorizations).toBe(0);
		});

		const after = await sweep().runOnce();
		expect(after.deleted.platform_rate_limits).toBe(1);
		expect(after.deleted.platform_mcp_authorizations).toBe(1);
	});

	it("is a no-op on empty tables and on a second run", async () => {
		const empty = await sweep().runOnce();
		expect(Object.values(empty.deleted)).toEqual([0, 0, 0, 0, 0, 0]);
		await rateLimit("rate-old", ago(2 * DAY));
		expect((await sweep().runOnce()).deleted.platform_rate_limits).toBe(1);
		expect((await sweep().runOnce()).deleted.platform_rate_limits).toBe(0);
	});
});

describe("runtime wiring", () => {
	const secrets = {
		QUOTUM_SECRETS_KEY_ID: "test",
		QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
		QUOTUM_AUTH_SECRET: testConfig.secret,
	};

	async function scheduledJobs(merchant: "merchant" | "headless"): Promise<QuotumScheduledJob[]> {
		const previous = Object.fromEntries(Object.keys(secrets).map((key) => [key, process.env[key]]));
		Object.assign(process.env, secrets);
		const jobs: QuotumScheduledJob[] = [];
		const runtime = createBillingRuntime(
			createIntegrationBillingEnv(process.env.POSTGRES_URI ?? ""),
			{
				merchant: merchant === "headless" ? null : { config: testConfig, mailer: fixture.mailer },
				scheduler: {
					schedule(job) {
						jobs.push(job);
						return { async stop() {} };
					},
				},
			},
		);
		try {
			await runtime.start();
		} finally {
			await runtime.stop();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		return jobs;
	}

	it("schedules the sweep when the merchant platform is enabled and it deletes expired rows", async () => {
		const jobs = await scheduledJobs("merchant");
		const job = jobs.find((candidate) => candidate.name === "platform_retention");
		expect(job?.pollIntervalMs).toBe(15 * 60_000);
		expect(jobs.filter((candidate) => candidate.name === "platform_retention")).toHaveLength(1);
		const who = await actor();
		await sql`INSERT INTO platform_rate_limits(key_hash,count,reset_at) VALUES('rate-old',1,now()-interval '2 days'),('rate-live',1,now()+interval '1 hour')`;
		await sql`INSERT INTO platform_idempotency(principal_id,key,request_hash,result,created_at)
			VALUES(${who.principalId},'old','hash','{"ok":true}'::jsonb,now()-interval '31 days')`;

		await job?.runOnce();

		expect(await labels(sql`SELECT key_hash FROM platform_rate_limits`, "key_hash")).toEqual([
			"rate-live",
		]);
		expect(await sql`SELECT key FROM platform_idempotency`).toHaveLength(0);
	});

	it("does not schedule the sweep in a headless process", async () => {
		const jobs = await scheduledJobs("headless");
		expect(jobs.length).toBeGreaterThan(0);
		expect(jobs.map((job) => job.name)).not.toContain("platform_retention");
	});
});
