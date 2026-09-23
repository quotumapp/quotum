import { describe, expect, it } from "bun:test";
import {
	normalizeTrialEndInput,
	normalizeTrialStartInput,
	trialError,
	trialStartRequestHash,
} from "../../src/billing/plan-grants";

const start = {
	billingAccountId: "user_1",
	planKey: " pro ",
	durationDays: 14,
	metadata: { campaign: "spring" },
	idempotencyKey: "start-1",
	actor: null,
};

describe("trial inputs", () => {
	it("trims the plan key and keeps the hash independent of key order", () => {
		const normalized = normalizeTrialStartInput(start);

		expect(normalized.planKey).toBe("pro");
		expect(trialStartRequestHash(normalized)).toBe(
			trialStartRequestHash({ ...normalized, metadata: { campaign: "spring" } }),
		);
		expect(trialStartRequestHash(normalized)).not.toBe(
			trialStartRequestHash({ ...normalized, durationDays: 7 }),
		);
	});

	it("rejects durations outside 1 to 730 days, oversized metadata and long reasons", () => {
		for (const durationDays of [0, 731, 1.5]) {
			expect(() => normalizeTrialStartInput({ ...start, durationDays })).toThrow("durationDays");
		}
		expect(() =>
			normalizeTrialStartInput({ ...start, metadata: { note: "x".repeat(4100) } }),
		).toThrow("metadata");
		expect(() =>
			normalizeTrialEndInput({
				billingAccountId: "user_1",
				trialId: "trial",
				reason: "x".repeat(501),
				idempotencyKey: "end",
				actor: null,
			}),
		).toThrow("reason");
		expect(
			normalizeTrialEndInput({
				billingAccountId: "user_1",
				trialId: "trial",
				reason: "  ",
				idempotencyKey: "end",
				actor: null,
			}).reason,
		).toBeNull();
	});

	it("maps each trial error to its status and carries details", () => {
		expect(trialError("TRIAL_NOT_FOUND").status).toBe(404);
		expect(trialError("TRIAL_DURATION_REQUIRED").status).toBe(400);
		const used = trialError("TRIAL_ALREADY_USED", { planKey: "pro" });
		expect({ status: used.status, code: used.code, details: used.details }).toEqual({
			status: 409,
			code: "TRIAL_ALREADY_USED",
			details: { planKey: "pro" },
		});
	});
});
