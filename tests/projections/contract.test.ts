import { describe, expect, it } from "bun:test";
import {
	projectionDeliveryJsonSchema,
	projectionDeliverySchema,
} from "../../src/projections/contract";
import { projectionDeliveryExamples } from "../../src/projections/delivery-examples";
import {
	publishedDeliveryExamples,
	publishedDeliverySchema,
	validateDelivery,
	validateDocumentedDelivery,
} from "../helpers/projection-contract";

type Delivery = Record<string, unknown>;

const example = (name: string): Delivery =>
	structuredClone(projectionDeliveryExamples[name]?.delivery) as unknown as Delivery;
const planGrantTrial = {
	event: "ended",
	source: "plan_grant",
	planGrantId: "0192f3a1-9a00-7c00-8d00-0e0f10111213",
	planKey: "pro",
	trialStartsAt: "2026-10-01T09:30:00.000Z",
	trialEndsAt: "2026-10-15T09:30:00.000Z",
	autoRenew: false,
};

describe("projection delivery contract", () => {
	it("publishes the schema and examples the code renders", () => {
		expect(publishedDeliverySchema).toEqual(
			JSON.parse(JSON.stringify(projectionDeliveryJsonSchema())),
		);
		expect(publishedDeliveryExamples).toEqual(
			JSON.parse(JSON.stringify(projectionDeliveryExamples)),
		);
		expect(Object.keys(publishedDeliveryExamples)).toEqual([
			"stripe_one_time_purchase",
			"stripe_one_time_refund",
			"stripe_subscription_cancel_scheduled",
			"stripe_subscription_ended",
			"stripe_subscription_purchase",
			"stripe_subscription_renewal",
			"stripe_trial_ending",
			"stripe_trial_started",
		]);
	});

	it("accepts every published example and names every field they carry", () => {
		for (const [name, { delivery }] of Object.entries(publishedDeliveryExamples)) {
			expect([name, projectionDeliverySchema.safeParse(delivery).success]).toEqual([name, true]);
			validateDocumentedDelivery(delivery);
			expect([name, validateDocumentedDelivery.errors ?? []]).toEqual([name, []]);
		}
	});

	it("keeps objects open, so a field added later still validates", () => {
		const delivery = example("stripe_subscription_renewal");
		const later = {
			...delivery,
			addedLater: true,
			subscription: { ...(delivery.subscription as Delivery), addedLater: true },
		};

		expect(validateDelivery(later)).toBe(true);
		expect(validateDocumentedDelivery(later)).toBe(false);
	});

	it("states the rules between fields the way the worker's own schema enforces them", () => {
		const purchase = example("stripe_one_time_purchase");
		const refund = example("stripe_one_time_refund");
		const trial = example("stripe_trial_ending");
		const cases: Array<[string, Delivery, boolean]> = [
			["a purchase with a reversal", { ...purchase, reversal: refund.reversal }, false],
			["a trial with a purchase", { ...trial, purchase: purchase.purchase }, false],
			["a trial with a reversal", { ...trial, reversal: refund.reversal }, false],
			["a plan-grant trial", { ...trial, subscription: undefined, trial: planGrantTrial }, true],
			[
				"a subscription trial without its subscription",
				{ ...trial, trial: { ...(trial.trial as Delivery), externalSubscriptionId: undefined } },
				false,
			],
			[
				"a subscription trial naming a plan grant",
				{ ...trial, trial: { ...(trial.trial as Delivery), planGrantId: "grant_1" } },
				false,
			],
			[
				"a plan-grant trial naming a provider",
				{ ...trial, trial: { ...planGrantTrial, provider: "stripe" } },
				false,
			],
			["another schema version", { ...purchase, schemaVersion: 2 }, false],
			["no idempotency key", { ...purchase, idempotencyKey: undefined }, false],
			["no sequence", { ...purchase, sequence: undefined }, true],
			[
				"a balance that is a number",
				{
					...purchase,
					balances: [
						{ featureKey: "tokens", unit: "token", available: 10, held: "0", periodEndsAt: null },
					],
				},
				false,
			],
			[
				"an unlimited balance",
				{
					...purchase,
					balances: [
						{
							featureKey: "tokens",
							unit: "token",
							available: "1250.5",
							held: "0",
							periodEndsAt: "2026-11-01T00:00:00.000Z",
							unlimited: true,
						},
					],
				},
				true,
			],
		];

		for (const [name, candidate, valid] of cases) {
			// A JSON body has no undefined members.
			const delivery = JSON.parse(JSON.stringify(candidate));
			expect([name, projectionDeliverySchema.safeParse(delivery).success]).toEqual([name, valid]);
			expect([name, validateDelivery(delivery)]).toEqual([name, valid]);
		}
	});
});
