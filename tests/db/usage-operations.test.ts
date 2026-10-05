import { describe, expect, it } from "bun:test";
import type { BalanceAllocationBreakdown, UsageCorrectionResult } from "../../src/billing/metering";
import type { UsageOperationInput } from "../../src/billing/usage-operations";
import {
	operationFingerprint,
	withChangedAllocationsOnly,
} from "../../src/db/repository/usage-operations";

const input = {
	billingAccountId: "account",
	featureKey: "credits",
	quantity: "10",
	idempotencyKey: "job",
};

describe("usage operation fingerprints", () => {
	it("does not depend on the order of Unicode-equivalent metadata keys", () => {
		const precomposed = "\u00e9";
		const decomposed = "e\u0301";
		const first = operationFingerprint("reserve", {
			...input,
			metadata: { [precomposed]: 1, [decomposed]: 2 },
		});
		expect(
			operationFingerprint("reserve", {
				...input,
				metadata: { [decomposed]: 2, [precomposed]: 1 },
			}),
		).toBe(first);
		expect(
			operationFingerprint("reserve", {
				...input,
				metadata: { [precomposed]: 2, [decomposed]: 1 },
			}),
		).not.toBe(first);
	});

	it("a legacy fingerprint matches the one stored before key ties were ordered", () => {
		const metadata = { b: 1, B: 2 };
		expect(operationFingerprint("consume", { ...input, metadata }, true)).toBe(
			operationFingerprint("consume", { ...input, metadata }),
		);
	});

	it("canonicalizes decimal, date, object order and default-empty optional fields", () => {
		const first = operationFingerprint("consume", {
			...input,
			metadata: { a: 1, nested: { c: 3, b: 2 } },
			occurredAt: new Date("2026-09-01T10:00:00+02:00"),
		});
		expect(
			operationFingerprint("consume", {
				...input,
				billingAccountId: " account ",
				featureKey: " credits ",
				quantity: "10.000",
				entityId: null,
				filters: {},
				metadata: { nested: { b: 2, c: 3 }, a: 1 },
				occurredAt: new Date("2026-09-01T08:00:00Z"),
			}),
		).toBe(first);
		expect(
			operationFingerprint("consume", {
				...input,
				metadata: {},
				filters: {},
				occurredAt: null,
				entityId: null,
			}),
		).toBe(operationFingerprint("consume", input));
	});

	it("binds operation-specific semantics while keeping caller ID outside the fingerprint", () => {
		const first = operationFingerprint("consume", input);
		expect(operationFingerprint("consume", { ...input, idempotencyKey: "another-key" })).toBe(
			first,
		);
		for (const changes of [
			{ billingAccountId: "other" },
			{ featureKey: "other" },
			{ quantity: "11" },
			{ entityId: "child" },
			{ filters: { model: "a" } },
			{ metadata: { job: 2 } },
			{ occurredAt: new Date("2026-09-01T08:00:00Z") },
		])
			expect(operationFingerprint("consume", { ...input, ...changes })).not.toBe(first);
		const reserve = { ...input, expiresInSeconds: 60 };
		expect(operationFingerprint("reserve", reserve)).not.toBe(first);
		expect(operationFingerprint("reserve", { ...reserve, expiresInSeconds: 61 })).not.toBe(
			operationFingerprint("reserve", reserve),
		);
		const confirm = { ...input, reservationId: "reservation-1" };
		expect(
			operationFingerprint("confirm", { ...confirm, reservationId: "reservation-2" }),
		).not.toBe(operationFingerprint("confirm", confirm));
		const correction = {
			...input,
			originalUsageEventId: "event-1",
			originalRecordedAt: new Date("2026-09-01T08:00:00Z"),
			actor: "operator",
			reason: "duplicate",
		};
		for (const changes of [
			{ originalUsageEventId: "event-2" },
			{ originalRecordedAt: new Date("2026-09-02T08:00:00Z") },
			{ actor: "other" },
			{ reason: "other" },
		]) {
			expect(
				operationFingerprint("correct", { ...correction, ...changes } as UsageOperationInput),
			).not.toBe(operationFingerprint("correct", correction));
		}
	});
});

describe("usage operation outcomes too large to retain", () => {
	function allocation(allocationId: string): BalanceAllocationBreakdown {
		return {
			allocationId,
			entityId: null,
			sourceKind: "credit_grant",
			sourceKey: `grant:${allocationId}`,
			rolloverOriginAllocationId: null,
			carryOverOriginAllocationId: null,
			rolloverPolicyRevision: null,
			quantity: "10",
			reversed: "0",
			consumed: "0",
			held: "0",
			available: "10",
			periodStartAt: null,
			periodEndAt: null,
			expiresAt: null,
			createdAt: "2026-09-01T00:00:00.000Z",
		};
	}

	it("keeps only the allocations the operation changed and every total", () => {
		const result: UsageCorrectionResult = {
			usageEventId: "event-2",
			recordedAt: "2026-09-02T00:00:00.000Z",
			originalUsageEventId: "event-1",
			originalRecordedAt: "2026-09-01T00:00:00.000Z",
			quantity: "-3",
			walletQuantity: "-3",
			balance: {
				featureKey: "credits",
				unit: "credit",
				scale: 0,
				granted: "30",
				consumed: "4",
				held: "0",
				available: "26",
				breakdown: [allocation("1"), allocation("2"), allocation("3")],
			},
			deductions: [
				{
					allocationId: "3",
					quantity: "-3",
					sourceKind: "credit_grant",
					sourceKey: "grant:3",
					expiresAt: null,
				},
			],
		};
		const compact = withChangedAllocationsOnly(result);
		expect(compact).toEqual({
			...result,
			balance: { ...result.balance, breakdown: [allocation("3")] },
		});
		expect(result.balance.breakdown).toHaveLength(3);
	});
});
