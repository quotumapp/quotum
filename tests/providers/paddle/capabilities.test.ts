import { describe, expect, it } from "bun:test";
import { evaluateRuntimeCapability } from "../../../src/providers/capabilities";
import { paddleCapabilities } from "../../../src/providers/paddle/capabilities";
import {
	evaluateCapability,
	providerOperations,
	validateDeclaration,
} from "../../../src/shared/provider-capabilities";

const qualified = new Set([
	"catalog.product.subscription",
	"catalog.price.flat",
	"checkout.hosted",
	"webhook.ingest",
	"event.replay",
]);
const facts = {
	configuration: { connectionEnabled: true, connectionValidated: true, accountFlags: {} },
};

describe("Paddle sandbox capability declaration", () => {
	it("admits a web adapter while documenting its sandbox scope", () => {
		expect(validateDeclaration(paddleCapabilities)).toEqual([]);
		expect(paddleCapabilities).toMatchObject({
			provider: "paddle",
			channel: "web",
			connectionKind: "paddle",
			availability: "available",
		});
		expect(Object.keys(paddleCapabilities.operations).sort()).toEqual(
			[...providerOperations].sort(),
		);
	});
	it("requires reconciliation for writes without provider idempotency keys", () => {
		expect(paddleCapabilities.writeSemantics).toEqual({
			clientIdempotencyKeys: false,
			uncertainWrite: "reconcile_required",
		});
	});
	it.each([...providerOperations])("publishes only the qualified scope for %s", (operation) => {
		const entry = paddleCapabilities.operations[operation];
		const verdict = evaluateCapability(paddleCapabilities, operation, facts);
		if (qualified.has(operation)) {
			expect(verdict.outcome).toBe("available");
			expect(entry.verification).toMatchObject({
				status: "conditional",
				verifiedOn: "2026-10-03",
				evidence: { tests: ["tests/integration/paddle-flows.test.ts"] },
			});
			expect(entry.notes).toContain("Sandbox fixed subscription scope");
		} else {
			expect(verdict.outcome).toBe("blocked");
			expect(["provider", "implementation"]).toContain(verdict.blockingLayer ?? "");
		}
	});
	it("keeps money-moving worker groups unavailable until their dispatchers exist", () => {
		for (const operation of [
			"subscription.change.apply",
			"subscription.change.period_end",
			"settlement.collect_finalized_charge",
			"adjustment.issue",
			"topup.automatic",
		] as const)
			expect(paddleCapabilities.operations[operation].level).toBe("unsupported");
	});
	it("refuses checkout through a disabled connection", () => {
		expect(
			evaluateRuntimeCapability("paddle", "checkout.hosted", {
				configuration: { ...facts.configuration, connectionEnabled: false },
			}).blockingLayer,
		).toBe("configuration");
	});
});
