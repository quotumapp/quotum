import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "../../src/billing/errors";
import { assertPlanCadences, assertTopupCadences } from "../../src/catalog/cadence-rules";
import type { CatalogPlanItemIntent, CatalogTopupIntent } from "../../src/catalog/types";

const topup: CatalogTopupIntent = {
	key: "credits_1000",
	featureKey: "credits",
	quantity: "1000",
	expiresAfterSeconds: null,
	providerBindings: [],
};

const allocation: CatalogPlanItemIntent = {
	featureKey: "credits",
	itemKind: "allocation",
	quantity: "100",
	resetInterval: "month",
	resetIntervalCount: 1,
	expiresAfterSeconds: null,
	overagePolicy: "blocked",
};

function plan(item: CatalogPlanItemIntent) {
	return {
		key: "pro",
		name: "Pro",
		version: 1,
		currency: null,
		baseAmountMinor: null,
		billingInterval: null,
		trialDays: null,
		items: [item],
		providerBindings: [],
	};
}

describe("calendar expiry rules", () => {
	it("accepts a calendar expiry, or none, on a top-up and an allocation", () => {
		expect(() =>
			assertTopupCadences({ ...topup, expiryInterval: "hour", expiryIntervalCount: 6 }),
		).not.toThrow();
		expect(() => assertTopupCadences(topup)).not.toThrow();
		expect(() =>
			assertPlanCadences(plan({ ...allocation, expiryInterval: "week", expiryIntervalCount: 2 })),
		).not.toThrow();
	});

	it("refuses an expiry count without an interval and a cadence combined with seconds", () => {
		expect(() => assertTopupCadences({ ...topup, expiryIntervalCount: 2 })).toThrow(
			new InvalidRequestError("Top-up credits_1000 expiry count requires an interval"),
		);
		expect(() =>
			assertTopupCadences({
				...topup,
				expiresAfterSeconds: 86_400,
				expiryInterval: "day",
				expiryIntervalCount: 1,
			}),
		).toThrow(
			new InvalidRequestError(
				"Top-up credits_1000 cannot expire both after seconds and on a cadence",
			),
		);
		expect(() => assertPlanCadences(plan({ ...allocation, expiryIntervalCount: 3 }))).toThrow(
			new InvalidRequestError("Plan pro item credits expiry count requires an interval"),
		);
	});

	it("bounds a calendar expiry's count and span", () => {
		expect(() =>
			assertTopupCadences({ ...topup, expiryInterval: "day", expiryIntervalCount: 1001 }),
		).toThrow(
			new InvalidRequestError(
				"Top-up credits_1000 expiry count must be a whole number from 1 to 1000",
			),
		);
		expect(() =>
			assertTopupCadences({ ...topup, expiryInterval: "year", expiryIntervalCount: 11 }),
		).toThrow(
			new InvalidRequestError("Top-up credits_1000 expiry cannot span more than 10 × year"),
		);
	});
});
