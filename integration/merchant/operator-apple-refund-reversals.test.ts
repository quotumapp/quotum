import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { runAppleRefundReversalsCommand } from "../../src/composition/cli/apple-refund-reversals";
import { MerchantBrowser, merchantFixture } from "./fixture";
import { operatorEnv, seedOperatorOrganization } from "./operator-fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

async function run(argv: string[], env = operatorEnv) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runAppleRefundReversalsCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	return { code, json: out.length > 0 ? JSON.parse(out.join("\n")) : null, error: err.join("\n") };
}

describe("Apple refund repair operator authorization", () => {
	it("allows member-organization reports and requires an audited override to apply", async () => {
		await seedOperatorOrganization(f);
		await new MerchantBrowser(f).signup();
		await f.sql`
			INSERT INTO platform_memberships (organization_id, principal_id, role)
			SELECT organization.id, principal.id, 'Owner'
			FROM platform_organizations organization, platform_principals principal
			WHERE organization.slug = 'ops'
		`;
		const env = { ...operatorEnv, QUOTUM_CONSOLE_ENABLED: "true" };
		const [event] = await f.sql<{ id: string }[]>`
			INSERT INTO store_events (project_id, provider, channel, event_type, external_event_id,
				processing_status, processed_at, raw_payload)
			SELECT id, 'apple', 'ios', 'REFUND_REVERSED', 'unresolved-reversal', 'processed', now(), '{}'
			FROM projects WHERE key = 'alpha'
			RETURNING id
		`;
		if (!event) throw new Error("Repair authorization fixture did not create its event");
		const report = await run(["report", "alpha"], env);
		expect(report).toMatchObject({ code: 2, json: { events: [{ reason: "purchase_missing" }] } });
		const denied = await run(["apply", "alpha", event.id], env);
		expect(denied.code).toBe(1);
		expect(denied.error).toContain("--member-override-reason");
		expect(
			await f.sql`SELECT id FROM platform_audit_events
			WHERE metadata->>'action' = 'apple.refund_reversal.repair'`,
		).toHaveLength(0);
		const allowed = await run(
			["apply", "alpha", event.id, "--member-override-reason", "owner requested balance repair"],
			env,
		);
		expect(allowed).toMatchObject({
			code: 2,
			json: { status: "blocked", reason: "purchase_missing" },
		});
		const audit = await f.sql<{ metadata: Record<string, unknown> }[]>`
			SELECT metadata FROM platform_audit_events
			WHERE metadata->>'action' = 'apple.refund_reversal.repair'
		`;
		expect(audit).toHaveLength(1);
		expect(audit[0]?.metadata).toMatchObject({
			operator: "ops-runbook",
			environment: "production",
			storeEventId: event.id,
			memberOverrideReason: "owner requested balance repair",
		});
		expect(await f.sql`SELECT processing_status FROM store_events WHERE id = ${event.id}`).toEqual([
			{ processing_status: "processed" },
		]);
	});
});
