import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import { validateStripeAccess } from "../../src/composition/stripe-connection-validation";

function client(failures: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const probe = (name: string) => async () => {
		calls.push(name);
		if (failures[name]) throw failures[name];
		return { id: "acct_test" };
	};
	const result = Object.fromEntries(
		[
			"prices",
			"products",
			"customers",
			"subscriptions",
			"invoices",
			"paymentIntents",
			"setupIntents",
			"paymentMethods",
			"coupons",
			"promotionCodes",
		].map((name) => [name, { list: probe(name) }]),
	);
	return {
		calls,
		stripe: {
			...result,
			accounts: { retrieve: probe("account") },
			checkout: { sessions: { list: probe("checkout") } },
		} as unknown as Stripe,
	};
}

describe("Stripe permission validation", () => {
	it("aggregates independent failures without exposing Stripe messages or keys", async () => {
		const { stripe, calls } = client({
			account: {
				statusCode: 403,
				message: "Key rk_live_SECRET lacks connected_account_read permission",
			},
			products: { statusCode: 403, message: "missing product_read" },
			invoices: { statusCode: 429 },
		});
		try {
			await validateStripeAccess(stripe);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({
				code: "STRIPE_CONNECTION_INVALID",
				details: {
					missingPermissions: ["connected_account_read", "product_read"],
					checks: expect.arrayContaining([
						{ check: "invoice_read", reason: "rate_limited", httpStatus: 429 },
					]),
				},
			});
			expect(JSON.stringify(error)).not.toContain("SECRET");
		}
		expect(calls).toHaveLength(12);
	});
	it("reports write permissions as unverified even when every read succeeds", async () => {
		const result = await validateStripeAccess(client().stripe);
		expect(result.identity).toBe("acct_test");
		expect(result.checks).toHaveLength(12);
		expect(result.unverifiedPermissions).toContain("subscription_write");
	});
	it("reads a permission Stripe names with its rak_ prefix and never echoes other text", async () => {
		const { stripe } = client({
			products: {
				statusCode: 403,
				message:
					"The provided key 'rk_live_SECRET' does not have the required permissions for this endpoint on account 'acct_1'. Having the 'rak_plan_read' permission would allow this request to continue.",
			},
			customers: { statusCode: 403, message: "No permissions were named here." },
		});
		try {
			await validateStripeAccess(stripe);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({
				details: {
					// A named permission wins; an unnamed one falls back to the failing probe.
					missingPermissions: ["customer_read", "plan_read"],
				},
			});
			expect(JSON.stringify(error)).not.toContain("SECRET");
		}
	});
});
