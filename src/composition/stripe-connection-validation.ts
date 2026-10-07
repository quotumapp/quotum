import type Stripe from "stripe";
import type { ConnectionValidation } from "../platform/connections/ports";
import { MerchantError } from "../platform/security";

/** Reads never certify the matching write permission. Keep this inventory aligned with the adapter. */
export const stripeUnverifiedPermissions = [
	"customer_write",
	"checkout_session_write",
	"customer_portal_write",
	"subscription_write",
	"invoice_write",
	"coupon_write",
	"promotion_code_write",
];

export async function validateStripeAccess(client: Stripe): Promise<ConnectionValidation> {
	let identity = "";
	const probes: Array<[string, () => Promise<unknown>]> = [
		[
			"connected_account_read",
			async () => {
				const account = await client.accounts.retrieve(null);
				identity = account.id;
			},
		],
		["plan_read", () => client.prices.list({ limit: 1 })],
		["product_read", () => client.products.list({ limit: 1 })],
		["customer_read", () => client.customers.list({ limit: 1 })],
		["checkout_session_read", () => client.checkout.sessions.list({ limit: 1 })],
		["subscription_read", () => client.subscriptions.list({ limit: 1 })],
		["invoice_read", () => client.invoices.list({ limit: 1 })],
		["payment_intent_read", () => client.paymentIntents.list({ limit: 1 })],
		["setup_intent_read", () => client.setupIntents.list({ limit: 1 })],
		["payment_method_read", () => client.paymentMethods.list({ limit: 1 })],
		["coupon_read", () => client.coupons.list({ limit: 1 })],
		["promotion_code_read", () => client.promotionCodes.list({ limit: 1 })],
	];
	const checks: Array<{
		check: string;
		reason: string;
		missingPermission?: string;
		httpStatus?: number;
	}> = [];
	const passed: ConnectionValidation["checks"] = [];
	for (let start = 0; start < probes.length; start += 4) {
		await Promise.all(
			probes.slice(start, start + 4).map(async ([check, probe]) => {
				try {
					await probe();
					passed.push({ code: check, passed: true });
				} catch (error) {
					const failure = error as { statusCode?: number; type?: string; message?: string };
					const status = failure.statusCode;
					// Extract only a permission token, never Stripe's free-form message or masked key. Stripe
					// may name a permission with its `rak_` prefix.
					const permission = failure.message
						?.match(/\b([a-z][a-z_]*(?:_read|_write))\b/u)?.[1]
						?.replace(/^rak_/u, "");
					checks.push({
						check,
						reason:
							status === 403
								? "missing_permission"
								: status === 401
									? "authentication_failed"
									: status === 429
										? "rate_limited"
										: "provider_unavailable",
						...(status === 403
							? {
									missingPermission:
										permission &&
										[...probes.map(([name]) => name), ...stripeUnverifiedPermissions].includes(
											permission,
										)
											? permission
											: check,
								}
							: {}),
						...(status === undefined ? {} : { httpStatus: status }),
					});
				}
			}),
		);
	}
	checks.sort((a, b) => a.check.localeCompare(b.check));
	if (checks.length)
		throw new MerchantError(
			"STRIPE_CONNECTION_INVALID",
			"Stripe validation failed; inspect details.checks and missingPermissions.",
			422,
			undefined,
			{
				checks,
				missingPermissions: [
					...new Set(
						checks.flatMap((check) => (check.missingPermission ? [check.missingPermission] : [])),
					),
				],
				unverifiedPermissions: stripeUnverifiedPermissions,
			},
		);
	return {
		identity,
		eventVerified: false,
		checks: passed.sort((a, b) => a.code.localeCompare(b.code)),
		unverifiedPermissions: stripeUnverifiedPermissions,
	};
}
