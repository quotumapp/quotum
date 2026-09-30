import { describe, expect, it } from "bun:test";
import { BillingError } from "../../../src/billing/errors";
import { assertAddOnMeterLimitsCombine } from "../../../src/providers/stripe/add-on-meter-limits";

describe("add-on meter limit check", () => {
	const addOn = { kind: "addon" as const, planVersionId: "7" };

	it("refuses an add-on whose meter limits cannot add up, naming the features", async () => {
		const asked: string[][] = [];
		const repository = {
			addOnMeterLimitConflicts: async (billingAccountId: string, planVersionId: string) => {
				asked.push([billingAccountId, planVersionId]);
				return ["api_requests", "exports"];
			},
		};
		const error = await assertAddOnMeterLimitsCombine(repository, "acct", addOn).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(BillingError);
		expect(error).toMatchObject({
			code: "ADDON_METER_LIMIT_CONFLICT",
			status: 409,
			details: { featureKeys: ["api_requests", "exports"] },
		});
		expect(asked).toEqual([["acct", "7"]]);
	});

	it("accepts an add-on without conflicts, and never asks about a base plan", async () => {
		let asked = 0;
		const repository = {
			addOnMeterLimitConflicts: async () => {
				asked += 1;
				return [];
			},
		};
		expect(await assertAddOnMeterLimitsCombine(repository, "acct", addOn)).toBeUndefined();
		expect(
			await assertAddOnMeterLimitsCombine(repository, "acct", { ...addOn, kind: "base" }),
		).toBeUndefined();
		expect(await assertAddOnMeterLimitsCombine({}, "acct", addOn)).toBeUndefined();
		expect(asked).toBe(1);
	});
});
