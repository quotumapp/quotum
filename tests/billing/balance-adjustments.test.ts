import { describe, expect, it } from "bun:test";
import {
	type AdministrativeDebitInput,
	administrativeDebitRequestHash,
	balanceAdjustmentError,
	normalizeAdministrativeDebitInput,
	normalizeOperatorGrantInput,
	normalizeOperatorGrantRevokeInput,
	type OperatorGrantInput,
	operatorGrantRequestHash,
	operatorGrantRevokeRequestHash,
} from "../../src/billing/balance-adjustments";

const grantInput: OperatorGrantInput = {
	billingAccountId: "acct_1",
	featureKey: " ai_credits ",
	quantity: "10.50",
	entityId: " ",
	expiresAt: new Date("2026-12-31T00:00:00.000Z"),
	reason: " Outage goodwill ",
	actor: "support@example.com",
	idempotencyKey: "grant-1",
};

const debitInput: AdministrativeDebitInput = {
	billingAccountId: "acct_1",
	allocations: [
		{ allocationId: "100", quantity: "2.0" },
		{ allocationId: "9", quantity: "1" },
	],
	reason: "Duplicate credit",
	actor: "support@example.com",
	idempotencyKey: "debit-1",
};

describe("operator grant input", () => {
	it("trims text, canonicalizes the quantity and drops a blank entity", () => {
		expect(normalizeOperatorGrantInput(grantInput)).toEqual({
			...grantInput,
			featureKey: "ai_credits",
			quantity: "10.5",
			entityId: null,
			reason: "Outage goodwill",
		});
	});

	it("hashes equal requests equally and a changed term differently", () => {
		const normalized = normalizeOperatorGrantInput(grantInput);
		const same = normalizeOperatorGrantInput({ ...grantInput, quantity: "10.5", actor: "other" });
		const otherExpiry = normalizeOperatorGrantInput({ ...grantInput, expiresAt: null });

		expect(operatorGrantRequestHash(same)).toBe(operatorGrantRequestHash(normalized));
		expect(operatorGrantRequestHash(otherExpiry)).not.toBe(operatorGrantRequestHash(normalized));
		expect(operatorGrantRequestHash(normalized)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("rejects a blank feature, a non-decimal quantity and an empty or long reason", () => {
		expect(() => normalizeOperatorGrantInput({ ...grantInput, featureKey: " " })).toThrow(
			"featureKey is required",
		);
		expect(() => normalizeOperatorGrantInput({ ...grantInput, quantity: "-1" })).toThrow(
			"quantity must be a non-negative decimal string",
		);
		expect(() => normalizeOperatorGrantInput({ ...grantInput, reason: " " })).toThrow(
			"reason must contain between 1 and 500 characters",
		);
		expect(() =>
			normalizeOperatorGrantRevokeInput({
				billingAccountId: "acct_1",
				grantId: "g",
				reason: "x".repeat(501),
				actor: "a",
				idempotencyKey: "k",
			}),
		).toThrow("reason must contain between 1 and 500 characters");
	});

	it("hashes a revocation by grant and reason", () => {
		const revoke = {
			billingAccountId: "acct_1",
			grantId: "g",
			reason: "Granted in error",
			actor: "a",
			idempotencyKey: "k",
		};
		expect(operatorGrantRevokeRequestHash(revoke)).toBe(
			operatorGrantRevokeRequestHash({ ...revoke, actor: "b" }),
		);
		expect(operatorGrantRevokeRequestHash(revoke)).not.toBe(
			operatorGrantRevokeRequestHash({ ...revoke, reason: "Other" }),
		);
	});
});

describe("administrative debit input", () => {
	it("orders lines by allocation id numerically, so the hash ignores the written order", () => {
		const normalized = normalizeAdministrativeDebitInput(debitInput);
		const reversed = normalizeAdministrativeDebitInput({
			...debitInput,
			allocations: [...debitInput.allocations].reverse(),
		});

		expect(normalized.allocations).toEqual([
			{ allocationId: "9", quantity: "1" },
			{ allocationId: "100", quantity: "2" },
		]);
		expect(administrativeDebitRequestHash(reversed)).toBe(
			administrativeDebitRequestHash(normalized),
		);
	});

	it("rejects a repeated allocation, a non-numeric id and an empty or oversized list", () => {
		expect(() =>
			normalizeAdministrativeDebitInput({
				...debitInput,
				allocations: [
					{ allocationId: "9", quantity: "1" },
					{ allocationId: "9", quantity: "2" },
				],
			}),
		).toThrow("allocation 9 is named more than once");
		expect(() =>
			normalizeAdministrativeDebitInput({
				...debitInput,
				allocations: [{ allocationId: "09", quantity: "1" }],
			}),
		).toThrow("allocationId must be a positive integer string");
		expect(() =>
			normalizeAdministrativeDebitInput({
				...debitInput,
				allocations: [{ allocationId: "9223372036854775808", quantity: "1" }],
			}),
		).toThrow("allocationId must be a positive integer string");
		expect(() => normalizeAdministrativeDebitInput({ ...debitInput, allocations: [] })).toThrow(
			"allocations must name between 1 and 20 allocations",
		);
		expect(() =>
			normalizeAdministrativeDebitInput({
				...debitInput,
				allocations: Array.from({ length: 21 }, (_, index) => ({
					allocationId: String(index + 1),
					quantity: "1",
				})),
			}),
		).toThrow("allocations must name between 1 and 20 allocations");
	});
});

describe("balance adjustment errors", () => {
	it("carries each code's status and optional details", () => {
		expect(balanceAdjustmentError("OPERATOR_GRANT_NOT_FOUND")).toMatchObject({
			code: "OPERATOR_GRANT_NOT_FOUND",
			status: 404,
		});
		expect(balanceAdjustmentError("OPERATOR_GRANT_FEATURE_INVALID")).toMatchObject({ status: 400 });
		expect(
			balanceAdjustmentError("ALLOCATION_NOT_DEBITABLE", { allocationId: "9", reason: "expired" }),
		).toMatchObject({
			status: 409,
			details: { allocationId: "9", reason: "expired" },
		});
		expect(
			balanceAdjustmentError("ADMINISTRATIVE_DEBIT_EXCEEDS_AVAILABLE").details,
		).toBeUndefined();
	});
});
