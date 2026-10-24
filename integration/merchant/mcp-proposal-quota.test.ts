import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { BillingChangesPort } from "../../src/platform/application/billing-changes";
import { McpChanges } from "../../src/platform/mcp/changes";
import { MCP_RESULT_BYTES } from "../../src/platform/mcp/proposal-limits";
import { PlatformRetentionSweep } from "../../src/platform/retention";
import { createDeferred } from "../../tests/helpers/deferred";
import { MerchantBrowser, merchantFixture, onboard } from "./fixture";

const f = merchantFixture({ mcp: { origin: "https://api.example.test", writesEnabled: true } });
afterAll(() => f.sql.close());
let prepareCalls = 0;
let applyCalls = 0;
let recoveryAvailable = true;
let before: unknown = {};
let prepareWait: Promise<void> | undefined;
let started: () => void = () => {};
let previewError = false;
const port: BillingChangesPort = {
	actions: [
		{
			action: "catalog.publish",
			capability: "catalog.publish.sandbox",
			stepUpAction: "catalog.publish",
			alwaysSensitive: false,
		},
	],
	async inspect() {
		return {};
	},
	async prepare(_context, input) {
		prepareCalls++;
		started();
		await prepareWait;
		if (previewError) throw new Error("preview failed");
		return { input, before, after: input.body, fingerprint: "test" };
	},
	async apply() {
		applyCalls++;
		return { status: 200, body: {} };
	},
	async recover() {
		if (!recoveryAvailable) return null;
		return { status: 200, body: { large: "x".repeat(MCP_RESULT_BYTES * 2) } };
	},
};
const changes = new McpChanges(f.store, port);
const target = { projectKey: "example", environment: "sandbox" as const };
const input = (key: string) => ({
	action: "catalog.publish",
	parameters: [],
	body: {},
	requestKey: key,
	reason: "Review catalog",
});
function limits(
	value: Partial<{
		maxPending: number;
		maxDaily: number;
		maxProposalBytes: number;
		maxRetainedBytes: number;
	}> = {},
) {
	const config = f.store.config.mcp;
	if (!config) throw new Error("Missing MCP config");
	config.proposalLimits = {
		maxPending: 100,
		maxDaily: 1000,
		maxProposalBytes: 131072,
		maxRetainedBytes: 1048576,
		...value,
	};
}
async function grant() {
	const browser = new MerchantBrowser(f);
	await onboard(browser);
	const identity = await f.store.authenticate(
		new Request("https://quotum.example/api/platform/session", {
			headers: { cookie: [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
		}),
	);
	const [row] = await f.sql<
		{ id: string; organization_id: string }[]
	>`INSERT INTO platform_mcp_authorizations(principal_id,organization_id,client_id,client_name,scopes,expires_at,approved_at) SELECT principal_id,organization_id,'quotum-claude-code','Quota test','["quotum.read","quotum.billing.write"]'::jsonb,now()+interval '30 days',now() FROM platform_memberships LIMIT 1 RETURNING id,organization_id`;
	if (!row) throw new Error("Missing grant");
	return { ...row, identity };
}
beforeEach(async () => {
	await f.reset();
	prepareCalls = 0;
	applyCalls = 0;
	recoveryAvailable = true;
	before = {};
	prepareWait = undefined;
	started = () => {};
	previewError = false;
	limits();
});
describe("organization proposal quotas", () => {
	it("admits only the available concurrent slots before expensive preview and rejects duplicate in-flight keys", async () => {
		const who = await grant();
		limits({ maxPending: 2 });
		const gate = createDeferred<void>();
		const admitted = createDeferred<void>();
		prepareWait = gate.promise;
		started = () => {
			if (prepareCalls === 2) admitted.resolve();
		};
		const first = changes.prepare(who.id, target, input("first"));
		const second = changes.prepare(who.id, target, input("second"));
		await admitted.promise;
		try {
			await expect(changes.prepare(who.id, target, input("third"))).rejects.toMatchObject({
				code: "MCP_QUOTA_EXCEEDED",
				status: 429,
			});
			await expect(changes.prepare(who.id, target, input("first"))).rejects.toMatchObject({
				code: "OPERATION_IN_PROGRESS",
				status: 409,
			});
			expect(prepareCalls).toBe(2);
		} finally {
			gate.resolve();
		}
		const saved = await Promise.all([first, second]);
		expect(saved).toHaveLength(2);
		expect(await f.sql`SELECT id FROM platform_mcp_proposal_admissions`).toHaveLength(0);
		expect((await changes.prepare(who.id, target, input("first"))).id).toBe(saved[0]?.id);
		expect(prepareCalls).toBe(2);
	});
	it.each(["needs_review", "expired applying"])(
		"releases the pending slot for unrecoverable %s while retaining its byte charge",
		async (state) => {
			const who = await grant();
			limits({ maxPending: 1 });
			const saved = await changes.prepare(who.id, target, input("uncertain"));
			recoveryAvailable = false;
			if (state === "needs_review") {
				await f.sql`UPDATE platform_mcp_changes SET status='needs_review' WHERE id=${saved.id}`;
			} else {
				await f.sql`UPDATE platform_mcp_changes SET status='applying',expires_at=clock_timestamp()-interval '1 second' WHERE id=${saved.id}`;
			}
			const next = await changes.prepare(who.id, target, input("next"));
			expect(next.status).toBe("pending");
			expect((await changes.get(who.id, saved.id)).status).toBe("needs_review");
			await f.sql`UPDATE platform_mcp_changes SET status='completed' WHERE id=${next.id}`;
			limits({ maxPending: 1, maxRetainedBytes: 131072 });
			await expect(changes.prepare(who.id, target, input("bytes-full"))).rejects.toMatchObject({
				code: "MCP_QUOTA_EXCEEDED",
			});
			expect(await f.sql`SELECT id FROM platform_mcp_changes WHERE id=${saved.id}`).toHaveLength(1);
			expect(applyCalls).toBe(0);
		},
	);
	it("keeps an unexpired applying proposal in the pending quota", async () => {
		const who = await grant();
		limits({ maxPending: 1 });
		const saved = await changes.prepare(who.id, target, input("applying"));
		await f.sql`UPDATE platform_mcp_changes SET status='applying' WHERE id=${saved.id}`;
		await expect(changes.prepare(who.id, target, input("blocked"))).rejects.toMatchObject({
			code: "MCP_QUOTA_EXCEEDED",
		});
		expect(prepareCalls).toBe(1);
	});
	it("retries an expired preparation admission with the same request key", async () => {
		const who = await grant();
		const gate = createDeferred<void>();
		const admitted = createDeferred<void>();
		prepareWait = gate.promise;
		started = () => admitted.resolve();
		const pending = changes.prepare(who.id, target, input("retry-key"));
		await admitted.promise;
		await f.sql`UPDATE platform_mcp_proposal_admissions SET expires_at=clock_timestamp()-interval '1 second'`;
		gate.resolve();
		await expect(pending).rejects.toMatchObject({
			code: "OPERATION_IN_PROGRESS",
			status: 409,
			message: "Preparation admission expired; retry with the same request key.",
		});
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(0);
		expect(await f.sql`SELECT id FROM platform_mcp_proposal_admissions`).toHaveLength(0);
		prepareWait = undefined;
		expect((await changes.prepare(who.id, target, input("retry-key"))).status).toBe("pending");
		expect(prepareCalls).toBe(2);
	});
	it("lets approval win during replacement preview without storing or executing a replacement", async () => {
		const who = await grant();
		const saved = await changes.prepare(who.id, target, input("original"));
		const gate = createDeferred<void>();
		const admitted = createDeferred<void>();
		prepareWait = gate.promise;
		started = () => admitted.resolve();
		const replacement = changes.prepare(who.id, target, {
			...input("replacement"),
			replacesChangeId: saved.id,
		});
		await admitted.promise;
		try {
			expect((await changes.decide(who.identity, saved.id, true, null)).status).toBe("completed");
		} finally {
			gate.resolve();
		}
		await expect(replacement).rejects.toMatchObject({ code: "ACTION_REJECTED", status: 409 });
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(1);
		expect(await f.sql`SELECT id FROM platform_mcp_proposal_admissions`).toHaveLength(0);
		expect((await changes.decide(who.identity, saved.id, true, null)).status).toBe("completed");
		expect(applyCalls).toBe(1);
	});
	it("restores old proposal columns with triggers disabled then backfills before enforcing ownership", async () => {
		const who = await grant();
		const saved = await changes.prepare(who.id, target, input("source"));
		await f.sql.begin(async (tx) => {
			await tx`ALTER TABLE platform_mcp_changes ALTER COLUMN organization_id DROP NOT NULL`;
			await tx`ALTER TABLE platform_mcp_changes DISABLE TRIGGER ALL`;
			const [restored] = await tx<
				{ id: string; organization_id: string | null; storage_bytes: string }[]
			>`
				INSERT INTO platform_mcp_changes(authorization_id,principal_id,project_instance_id,request_key,request_hash,action,parameters,body,reason,preview,capability,step_up_action,sensitive,scope,status,result,created_at,expires_at,applied_at)
				SELECT authorization_id,principal_id,project_instance_id,'restored',request_hash,action,parameters,body,reason,preview,capability,step_up_action,sensitive,scope,status,result,created_at,expires_at,applied_at
				FROM platform_mcp_changes WHERE id=${saved.id} RETURNING id,organization_id,storage_bytes`;
			if (!restored) throw new Error("Missing restored proposal");
			expect(restored.organization_id).toBeNull();
			expect(Number(restored.storage_bytes)).toBe(0);
			await tx`ALTER TABLE platform_mcp_changes ENABLE TRIGGER ALL`;
			await tx`UPDATE platform_mcp_changes SET preview=preview`;
			const [verification] = await tx<{ invalid_proposals: number }[]>`
				SELECT count(*)::integer AS invalid_proposals FROM platform_mcp_changes c
				LEFT JOIN platform_mcp_authorizations a ON a.id=c.authorization_id
				WHERE c.organization_id IS DISTINCT FROM a.organization_id OR c.organization_id IS NULL OR c.storage_bytes<=0`;
			expect(verification?.invalid_proposals).toBe(0);
			await tx`ALTER TABLE platform_mcp_changes ALTER COLUMN organization_id SET NOT NULL`;
			const [backfilled] = await tx<{ organization_id: string; storage_bytes: string }[]>`
				SELECT organization_id,storage_bytes FROM platform_mcp_changes WHERE id=${restored.id}`;
			expect(backfilled?.organization_id).toBe(who.organization_id);
			expect(Number(backfilled?.storage_bytes)).toBeGreaterThan(65536);
		});
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(2);
	});

	it("counts failed preparation attempts toward the UTC daily budget and releases their capacity", async () => {
		const who = await grant();
		limits({ maxDaily: 1 });
		previewError = true;
		await expect(changes.prepare(who.id, target, input("failed"))).rejects.toThrow(
			"preview failed",
		);
		previewError = false;
		await expect(changes.prepare(who.id, target, input("blocked"))).rejects.toMatchObject({
			code: "MCP_QUOTA_EXCEEDED",
			status: 429,
		});
		expect(prepareCalls).toBe(1);
		expect(await f.sql`SELECT id FROM platform_mcp_proposal_admissions`).toHaveLength(0);
		await f.sql`UPDATE platform_mcp_proposal_days SET day=day-1`;
		expect((await changes.prepare(who.id, target, input("tomorrow"))).status).toBe("pending");
	});
	it("rejects oversized complete snapshots and bounds retained bytes independently of pending count", async () => {
		const who = await grant();
		before = { catalog: "🔒".repeat(40000) };
		await expect(changes.prepare(who.id, target, input("oversize"))).rejects.toMatchObject({
			code: "MCP_PROPOSAL_TOO_LARGE",
			status: 413,
		});
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(0);
		before = {};
		limits({ maxRetainedBytes: 262144 });
		await changes.prepare(who.id, target, input("one"));
		await changes.prepare(who.id, target, input("two"));
		await expect(changes.prepare(who.id, target, input("three"))).rejects.toMatchObject({
			code: "MCP_QUOTA_EXCEEDED",
			status: 429,
		});
		const [bytes] =
			await f.sql`SELECT sum(storage_bytes)::integer AS bytes FROM platform_mcp_changes`;
		expect(bytes.bytes).toBeLessThanOrEqual(262144);
	});
	it("reclaims expired admissions, retains a bounded execution receipt, and accounts for old oversized proposals", async () => {
		const who = await grant();
		const saved = await changes.prepare(who.id, target, input("saved"));
		await f.sql`INSERT INTO platform_mcp_proposal_admissions(organization_id,authorization_id,request_key,request_hash,reserved_bytes,expires_at) VALUES(${who.organization_id},${who.id},'expired','hash',131072,now()-interval '1 second')`;
		await f.sql`UPDATE platform_mcp_changes SET status='needs_review' WHERE id=${saved.id}`;
		const recovered = await changes.get(who.id, saved.id);
		expect(recovered.status).toBe("completed");
		expect(recovered.result).toMatchObject({
			status: 200,
			body: { responseOmitted: true, operationKey: `mcp:${saved.id}` },
		});
		await changes.prepare(who.id, target, input("after-expiry"));
		expect(await f.sql`SELECT id FROM platform_mcp_proposal_admissions`).toHaveLength(0);
		await f.sql`UPDATE platform_mcp_changes SET preview=jsonb_set(preview,'{before}',to_jsonb(repeat('x',1100000))) WHERE id=${saved.id}`;
		expect((await changes.get(who.id, saved.id)).id).toBe(saved.id);
		await expect(changes.prepare(who.id, target, input("over-quota"))).rejects.toMatchObject({
			code: "MCP_QUOTA_EXCEEDED",
		});
		await f.sql`UPDATE platform_mcp_changes SET created_at=now()-interval '31 days',expires_at=now()-interval '31 days',status='completed'`;
		const sweep = await new PlatformRetentionSweep(f.sql).runOnce();
		expect(sweep.failures).toEqual([]);
		expect((await changes.prepare(who.id, target, input("after-retention"))).status).toBe(
			"pending",
		);
	});
});
