import { describe, expect, it } from "bun:test";
import { billingChangeActions } from "../../src/composition/billing-change-actions";
import { MCP_PROPOSAL_CAPABILITIES } from "../../src/platform/security";

describe("MCP proposal capabilities", () => {
	it("are exactly the capabilities a proposed billing change needs", () => {
		// A role that holds none of these cannot approve any change, so it may not keep the proposal
		// scope. An action needing a capability outside this set would let such a role keep it, and an
		// entry no action needs would let a role keep it for nothing.
		const needed = new Set<string>(billingChangeActions.map((action) => action.capability));
		// Catalog publication needs this one instead in production (see McpChanges.capabilities).
		needed.add("catalog.publish.production");
		expect(MCP_PROPOSAL_CAPABILITIES.map(String).sort()).toEqual([...needed].sort());
	});
});
