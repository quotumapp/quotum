import { describe, expect, it } from "bun:test";
import { BillingError } from "../../../src/billing/errors";
import {
	assertAddOnMeterLimitsCombine,
	assertMeterLimitScopesAgree,
} from "../../../src/providers/stripe/add-on-meter-limits";

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

describe("meter limit scope check", () => {
	it("refuses a plan whose limits declare another scope, with the reason", async () => {
		const asked: string[][] = [];
		const repository = {
			meterLimitScopeConflicts: async (billingAccountId: string, planVersionId: string) => {
				asked.push([billingAccountId, planVersionId]);
				return ["api_requests"];
			},
		};
		const error = await assertMeterLimitScopesAgree(repository, "acct", {
			planVersionId: "9",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BillingError);
		expect(error).toMatchObject({
			code: "ADDON_METER_LIMIT_CONFLICT",
			status: 409,
			details: { reason: "scope", featureKeys: ["api_requests"] },
		});
		expect(asked).toEqual([["acct", "9"]]);
	});

	it("accepts a plan without conflicts, or a repository that cannot tell", async () => {
		const repository = { meterLimitScopeConflicts: async () => [] };
		expect(
			await assertMeterLimitScopesAgree(repository, "acct", { planVersionId: "9" }),
		).toBeUndefined();
		expect(await assertMeterLimitScopesAgree({}, "acct", { planVersionId: "9" })).toBeUndefined();
	});
});
