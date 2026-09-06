import { describe, expect, it } from "bun:test";
import type { UsageOperationInput } from "../../src/billing/usage-operations";
import { operationFingerprint } from "../../src/db/repository/usage-operations";

const input = {
	billingAccountId: "account",
	featureKey: "credits",
	quantity: "10",
	idempotencyKey: "job",
};

describe("usage operation fingerprints", () => {
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
