import { describe, expect, it } from "bun:test";
import { validatePaddleItemSet, validatePaddlePrice } from "../../../src/providers/paddle/catalog";
import {
	paddleCancellationCommand,
	paddleChangeCommand,
	paddleCheckoutCommand,
	paddleProrationMode,
	paddleSubscriptionFingerprint,
} from "../../../src/providers/paddle/commands";
import { buildPaddleConfig } from "../../../src/providers/paddle/config";
import { projectInstanceContext } from "../../helpers/project-context";
import { binding, config, correlation, id, price, subscription } from "./fixtures";

describe("Paddle candidate commands", () => {
	it("refuses live and internal projects and builds an explicitly sandbox configuration", () => {
		expect(() => buildPaddleConfig(projectInstanceContext(), config)).toThrow("sandbox");
		expect(() =>
			buildPaddleConfig(
				projectInstanceContext("acme", { environment: "sandbox", internalProject: true }),
				config,
			),
		).toThrow("sandbox");
		expect(
			buildPaddleConfig(projectInstanceContext("acme", { environment: "sandbox" }), config),
		).toEqual(config);
	});
	it("validates price identity, amount, cadence, trial and quantity against the seller response", () => {
		expect(validatePaddlePrice(binding, price)).toEqual(price);
		for (const changed of [
			{ ...price, product_id: id("pro", "b") },
			{ ...price, status: "archived" },
			{ ...price, unit_price: { amount: "1200", currency_code: "USD" } },
			{ ...price, billing_cycle: { interval: "year", frequency: 1 } },
			{ ...price, trial_period: { interval: "day", frequency: 7 } },
			{ ...price, quantity: { minimum: 3, maximum: 100 } },
		])
			expect(() => validatePaddlePrice(binding, changed)).toThrow("published binding");
		expect(() => validatePaddlePrice({ ...binding, quantity: 1.5 }, price)).toThrow();
	});
	it("requires distinct complete item sets with a shared currency and cadence", () => {
		for (const bindings of [
			[],
			[binding, binding],
			[binding, { ...binding, priceId: id("pri", "b"), currency: "EUR" }],
			[
				binding,
				{
					...binding,
					priceId: id("pri", "b"),
					billingCycle: { interval: "year" as const, frequency: 1 },
				},
			],
		]) {
			expect(() => validatePaddleItemSet(bindings)).toThrow();
		}
	});
	it("creates hosted transactions with durable correlation and a fixed payment page", () => {
		const command = paddleCheckoutCommand({
			customerId: id("ctm"),
			bindings: [binding],
			config,
			correlation,
		});
		expect(command).toMatchObject({
			method: "POST",
			path: "/transactions",
			body: {
				collection_mode: "automatic",
				customer_id: id("ctm"),
				items: [{ price_id: price.id, quantity: 2 }],
				custom_data: { quotum: correlation },
				checkout: { url: config.paymentPageUrl },
			},
		});
		for (const paymentPageUrl of [
			"http://merchant.example",
			"https://user:pass@merchant.example",
			"https://merchant.example/pay?_ptxn=old",
		]) {
			expect(() =>
				paddleCheckoutCommand({
					customerId: id("ctm"),
					bindings: [binding],
					config: { paymentPageUrl },
					correlation,
				}),
			).toThrow();
		}
	});
	it("maps all five billing policies without confusing collection with entitlement timing", () => {
		expect(paddleProrationMode({ billing: "prorated", collection: "immediate" })).toBe(
			"prorated_immediately",
		);
		expect(paddleProrationMode({ billing: "full", collection: "immediate" })).toBe(
			"full_immediately",
		);
		expect(paddleProrationMode({ billing: "prorated", collection: "next_renewal" })).toBe(
			"prorated_next_billing_period",
		);
		expect(paddleProrationMode({ billing: "full", collection: "next_renewal" })).toBe(
			"full_next_billing_period",
		);
		expect(paddleProrationMode({ billing: "none", collection: "next_renewal" })).toBe(
			"do_not_bill",
		);
	});
	it("sends retained items and prevents changes on failed immediate payment", () => {
		const command = paddleChangeCommand(changeInput());
		expect(command.body).toMatchObject({
			items: [
				{ price_id: binding.priceId, quantity: 2 },
				{ price_id: id("pri", "b"), quantity: 2 },
			],
			on_payment_failure: "prevent_change",
			proration_billing_mode: "prorated_immediately",
			custom_data: { existing: "preserved", quotum: correlation },
		});
		expect(() => paddleChangeCommand({ ...changeInput(), effectiveMode: "period_end" })).toThrow(
			"not qualified",
		);
		expect(() => paddleChangeCommand({ ...changeInput(), expectedFingerprint: "stale" })).toThrow(
			"since preview",
		);
	});
	it("blocks renewal races, past-due/manual subscriptions and pending changes", () => {
		for (const changed of [
			{ ...subscription, status: "past_due" as const },
			{ ...subscription, collection_mode: "manual" as const },
			{
				...subscription,
				scheduled_change: { action: "cancel" as const, effective_at: "2026-11-01T00:00:00Z" },
			},
			{ ...subscription, next_billed_at: "2026-10-01T00:20:00Z" },
		])
			expect(() =>
				paddleChangeCommand({
					...changeInput(),
					subscription: changed,
					expectedFingerprint: paddleSubscriptionFingerprint(changed),
				}),
			).toThrow();
	});
	it("schedules cancellation and clears only a scheduled cancellation", () => {
		const input = {
			subscription,
			action: "cancel" as const,
			effectiveMode: "period_end" as const,
			now: Date.parse("2026-10-01T00:00:00Z"),
		};
		expect(paddleCancellationCommand(input)).toMatchObject({
			method: "POST",
			path: `/subscriptions/${subscription.id}/cancel`,
			body: { effective_from: "next_billing_period" },
		});
		expect(paddleCancellationCommand({ ...input, effectiveMode: "immediate" }).body).toEqual({
			effective_from: "immediately",
		});
		expect(
			paddleCancellationCommand({
				...input,
				action: "uncancel",
				subscription: {
					...subscription,
					scheduled_change: { action: "cancel", effective_at: "2026-11-01T00:00:00Z" },
				},
			}),
		).toMatchObject({ method: "PATCH", body: { scheduled_change: null } });
		expect(() => paddleCancellationCommand({ ...input, action: "uncancel" })).toThrow(
			"no scheduled cancellation",
		);
	});
});

function changeInput(): Parameters<typeof paddleChangeCommand>[0] {
	return {
		subscription,
		expectedFingerprint: paddleSubscriptionFingerprint(subscription),
		bindings: [binding, { ...binding, priceId: id("pri", "b") }],
		effectiveMode: "immediate",
		billingPolicy: { billing: "prorated", collection: "immediate" },
		correlation,
		now: Date.parse("2026-10-01T00:00:00Z"),
	};
}
