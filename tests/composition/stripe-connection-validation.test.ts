import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import {
	stripeWritePermissions,
	validateStripeAccess,
} from "../../src/composition/stripe-connection-validation";

/** What Stripe answers a permitted write that cannot succeed. */
const refusals: Record<string, unknown> = {
	"customers.update": { statusCode: 404, code: "resource_missing" },
	"subscriptions.update": { statusCode: 404, code: "resource_missing" },
	"invoices.update": { statusCode: 404, code: "resource_missing" },
	"checkout.create": { statusCode: 400, code: "parameter_invalid_enum" },
	"portal.create": { statusCode: 400, code: "resource_missing" },
	"coupons.create": { statusCode: 400, code: "parameter_invalid_enum" },
	"promotionCodes.create": { statusCode: 400, code: "parameter_missing" },
};

function client(failures: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const probe =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push({ name, args });
			const failure = failures[name] ?? refusals[name];
			if (failure) throw failure;
			return { id: "acct_test" };
		};
	const lists = Object.fromEntries(
		["prices", "products", "paymentIntents", "setupIntents", "paymentMethods"].map((name) => [
			name,
			{ list: probe(name) },
		]),
	);
	return {
		calls,
		names: () => calls.map((call) => call.name),
		stripe: {
			...lists,
			accounts: { retrieve: probe("account") },
			customers: { list: probe("customers"), update: probe("customers.update") },
			subscriptions: { list: probe("subscriptions"), update: probe("subscriptions.update") },
			invoices: { list: probe("invoices"), update: probe("invoices.update") },
			checkout: { sessions: { list: probe("checkout"), create: probe("checkout.create") } },
			billingPortal: { sessions: { create: probe("portal.create") } },
			coupons: { list: probe("coupons"), create: probe("coupons.create") },
			promotionCodes: { list: probe("promotionCodes"), create: probe("promotionCodes.create") },
		} as unknown as Stripe,
	};
}

async function rejection(stripe: Stripe): Promise<{ details: Record<string, unknown> }> {
	try {
		await validateStripeAccess(stripe);
	} catch (error) {
		return error as { details: Record<string, unknown> };
	}
	throw new Error("expected rejection");
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
		const error = await rejection(stripe);
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
		expect(calls).toHaveLength(19);
	});
	it("verifies each write permission with a request that cannot succeed", async () => {
		const { stripe, calls } = client();

		const result = await validateStripeAccess(stripe);

		expect(result.identity).toBe("acct_test");
		expect(result.unverifiedPermissions).toEqual([]);
		expect(result.checks).toHaveLength(19);
		expect(result.checks.filter((check) => check.code.endsWith("_write"))).toEqual(
			[...stripeWritePermissions].sort().map((code) => ({ code, passed: true })),
		);
		const writes = Object.fromEntries(
			calls.filter((call) => call.name in refusals).map((call) => [call.name, call.args]),
		);
		expect(writes).toEqual({
			"customers.update": ["cus_quotum_permission_probe", {}],
			"subscriptions.update": ["sub_quotum_permission_probe", {}],
			"invoices.update": ["in_quotum_permission_probe", {}],
			"checkout.create": [{ mode: "quotum_permission_probe" }],
			"portal.create": [{ customer: "cus_quotum_permission_probe" }],
			"coupons.create": [{ duration: "quotum_permission_probe" }],
			"promotionCodes.create": [{}],
		});
	});
	it("fails validation for a write permission the key lacks and names it", async () => {
		const { stripe } = client({
			"subscriptions.update": {
				statusCode: 403,
				message:
					"The provided key 'rk_live_SECRET' does not have the required permissions for this endpoint. Having the 'rak_subscription_write' permission would allow this request to continue.",
			},
			"coupons.create": { statusCode: 403, message: "No permissions were named here." },
		});

		const error = await rejection(stripe);

		expect(error.details).toEqual({
			checks: [
				{
					check: "coupon_write",
					reason: "missing_permission",
					missingPermission: "coupon_write",
					httpStatus: 403,
				},
				{
					check: "subscription_write",
					reason: "missing_permission",
					missingPermission: "subscription_write",
					httpStatus: 403,
				},
			],
			missingPermissions: ["coupon_write", "subscription_write"],
			unverifiedPermissions: [],
		});
		expect(JSON.stringify(error)).not.toContain("SECRET");
	});
	it("leaves a write permission unverified when its probe proves nothing", async () => {
		const { stripe } = client({
			"customers.update": { statusCode: 429 },
			"invoices.update": { statusCode: 503 },
			"checkout.create": new Error("socket hang up"),
			"portal.create": { statusCode: 402 },
		});

		const result = await validateStripeAccess(stripe);

		expect(result.unverifiedPermissions).toEqual([
			"customer_write",
			"checkout_session_write",
			"customer_portal_write",
			"invoice_write",
		]);
		expect(result.checks.map((check) => check.code)).not.toContain("customer_write");
		expect(result.checks.map((check) => check.code)).toContain("subscription_write");
	});
	it("sends no write when the probes are turned off or the key is not accepted", async () => {
		const disabled = client();
		const result = await validateStripeAccess(disabled.stripe, { writeProbes: false });
		expect(result.checks).toHaveLength(12);
		expect(result.unverifiedPermissions).toEqual([...stripeWritePermissions]);
		expect(disabled.names().filter((name) => name in refusals)).toEqual([]);

		const unauthenticated = client({ account: { statusCode: 401 } });
		const error = await rejection(unauthenticated.stripe);
		expect(error.details.unverifiedPermissions).toEqual([...stripeWritePermissions]);
		expect(unauthenticated.names().filter((name) => name in refusals)).toEqual([]);
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
		const error = await rejection(stripe);
		expect(error).toMatchObject({
			details: {
				// A named permission wins; an unnamed one falls back to the failing probe.
				missingPermissions: ["customer_read", "plan_read"],
			},
		});
		expect(JSON.stringify(error)).not.toContain("SECRET");
	});
});
