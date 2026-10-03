import { describe, expect, it } from "bun:test";
import {
	billingChangeActions,
	prepareBillingChangeSchema,
} from "../../src/composition/billing-change-actions";

const proposal = {
	requestKey: "team-a",
	reason: "Team allowance",
	change: {
		action: "entities.write",
		parameters: ["customer-a"],
		body: { externalId: "team-a", kind: "team" },
	},
};
describe("remote billing proposal boundary", () => {
	it("accepts typed proposals and refuses caller authority and arbitrary execution", () => {
		expect(prepareBillingChangeSchema.safeParse(proposal).success).toBe(true);
		for (const change of [
			{ ...proposal.change, action: "POST /v1/admin/operator-grants/customer-a" },
			{ ...proposal.change, actor: "operator" },
			{ ...proposal.change, body: { ...proposal.change.body, projectId: "other-tenant" } },
			{ ...proposal.change, parameters: ["customer-a", "unexpected"] },
		])
			expect(prepareBillingChangeSchema.safeParse({ ...proposal, change }).success).toBe(false);
		expect(prepareBillingChangeSchema.safeParse({ ...proposal, approved: true }).success).toBe(
			false,
		);
		expect(prepareBillingChangeSchema.safeParse({ ...proposal, requestKey: "" }).success).toBe(
			false,
		);
	});
	it("gates recovery actions and excludes credentials, consuming usage and global reconciliation", () => {
		const names = billingChangeActions.map((a) => a.action);
		expect(new Set(names).size).toBe(names.length);
		expect(names).not.toContain("usage.consume");
		expect(
			names.some((name) => /credential|connection|reconciliation|reservation/.test(name)),
		).toBe(false);
		for (const name of ["events.replay", "projections.retry"]) {
			const action = billingChangeActions.find((a) => a.action === name);
			expect(action?.capability).toBe("operations.recover");
			expect(action?.alwaysSensitive).toBe(true);
		}
	});
});
