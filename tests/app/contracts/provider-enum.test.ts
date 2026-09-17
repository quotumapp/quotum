import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { billingProviderValues } from "../../../src/app/contracts/provider-enum";
import { billingProviders } from "../../../src/billing/types";

describe("billingProviderValues", () => {
	it("returns the declaration order without leading providers", () => {
		expect(billingProviderValues()).toEqual([...billingProviders]);
	});

	it("keeps the enum orders the published contract already renders", () => {
		expect(billingProviderValues("google")).toEqual(["google", "apple", "stripe"]);
		expect(billingProviderValues("stripe")).toEqual(["stripe", "apple", "google"]);
		expect(z.toJSONSchema(z.enum(billingProviderValues("google")))).toMatchObject({
			enum: ["google", "apple", "stripe"],
		});
	});

	it("lists every billing provider exactly once", () => {
		const values = billingProviderValues("stripe", "apple");
		expect(new Set(values).size).toBe(values.length);
		expect([...values].sort()).toEqual([...billingProviders].sort());
	});
});
