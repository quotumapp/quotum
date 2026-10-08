import type Stripe from "stripe";
import type { ConnectionValidation } from "../platform/connections/ports";
import { MerchantError } from "../platform/security";

/** The writes the adapter makes. A read never certifies one. Keep aligned with the adapter. */
export const stripeWritePermissions = [
	"customer_write",
	"checkout_session_write",
	"customer_portal_write",
	"subscription_write",
	"invoice_write",
	"coupon_write",
	"promotion_code_write",
] as const;

type Probe = [check: string, run: () => Promise<unknown>];

interface FailedCheck {
	check: string;
	reason: string;
	missingPermission?: string;
	httpStatus?: number;
}

/** Stripe issues every object id, so no customer, subscription or invoice can carry this one. */
const absent = "quotum_permission_probe";

function readProbes(client: Stripe, identified: (accountId: string) => void): Probe[] {
	return [
		["connected_account_read", async () => identified((await client.accounts.retrieve(null)).id)],
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
}

/**
 * Stripe checks a key's permission before it looks at the request, so a write that cannot succeed
 * still tells the two apart: 403 without the permission, 404 or 400 with it. Every probe names an
 * object that cannot exist, omits a required parameter or sends a value Stripe rejects, so none
 * can create or change anything whichever check runs first. That order is how Stripe behaves, not
 * something it documents, which is why `BILLING_STRIPE_WRITE_PERMISSION_PROBES=false` turns the
 * probes off.
 */
function writeProbes(client: Stripe): Probe[] {
	return [
		["customer_write", () => client.customers.update(`cus_${absent}`, {})],
		["subscription_write", () => client.subscriptions.update(`sub_${absent}`, {})],
		["invoice_write", () => client.invoices.update(`in_${absent}`, {})],
		[
			"checkout_session_write",
			() =>
				client.checkout.sessions.create({
					mode: absent,
				} as unknown as Stripe.Checkout.SessionCreateParams),
		],
		[
			"customer_portal_write",
			() => client.billingPortal.sessions.create({ customer: `cus_${absent}` }),
		],
		[
			"coupon_write",
			() => client.coupons.create({ duration: absent } as unknown as Stripe.CouponCreateParams),
		],
		[
			"promotion_code_write",
			() => client.promotionCodes.create({} as unknown as Stripe.PromotionCodeCreateParams),
		],
	];
}

type ProbeResult = { check: string; ok: true } | { check: string; ok: false; error: unknown };

/** Runs the probes four at a time, in order. */
async function run(probes: Probe[]): Promise<ProbeResult[]> {
	const results: ProbeResult[] = [];
	for (let start = 0; start < probes.length; start += 4) {
		results.push(
			...(await Promise.all(
				probes.slice(start, start + 4).map(async ([check, probe]): Promise<ProbeResult> => {
					try {
						await probe();
						return { check, ok: true };
					} catch (error) {
						return { check, ok: false, error };
					}
				}),
			)),
		);
	}
	return results;
}

function statusOf(error: unknown): number | undefined {
	const status = (error as { statusCode?: unknown } | null)?.statusCode;
	return typeof status === "number" ? status : undefined;
}

function failedCheck(check: string, error: unknown, permissions: string[]): FailedCheck {
	const status = statusOf(error);
	// Extract only a permission token, never Stripe's free-form message or masked key. Stripe
	// may name a permission with its `rak_` prefix.
	const permission = (error as { message?: string } | null)?.message
		?.match(/\b([a-z][a-z_]*(?:_read|_write))\b/u)?.[1]
		?.replace(/^rak_/u, "");
	return {
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
			? { missingPermission: permission && permissions.includes(permission) ? permission : check }
			: {}),
		...(status === undefined ? {} : { httpStatus: status }),
	};
}

export async function validateStripeAccess(
	client: Stripe,
	options: { writeProbes?: boolean } = {},
): Promise<ConnectionValidation> {
	let identity = "";
	const reads = readProbes(client, (accountId) => {
		identity = accountId;
	});
	const permissions = [...reads.map(([check]) => check), ...stripeWritePermissions];
	const checks: FailedCheck[] = [];
	const passed: ConnectionValidation["checks"] = [];
	for (const result of await run(reads)) {
		if (result.ok) passed.push({ code: result.check, passed: true });
		else checks.push(failedCheck(result.check, result.error, permissions));
	}

	const settled = new Set<string>();
	// A key Stripe does not accept answers every request the same way; the reads already said so.
	const authenticated = !checks.some((check) => check.reason === "authentication_failed");
	if (options.writeProbes !== false && authenticated) {
		for (const result of await run(writeProbes(client))) {
			const status = result.ok ? undefined : statusOf(result.error);
			if (result.ok || status === 404 || status === 400) {
				passed.push({ code: result.check, passed: true });
			} else if (status === 403 || status === 401) {
				checks.push(failedCheck(result.check, result.error, permissions));
			} else {
				// A rate limit or an outage proves nothing either way: the permission stays
				// unverified instead of failing a connection whose reads all passed.
				continue;
			}
			settled.add(result.check);
		}
	}
	const unverifiedPermissions = stripeWritePermissions.filter(
		(permission) => !settled.has(permission),
	);

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
				unverifiedPermissions,
			},
		);
	return {
		identity,
		eventVerified: false,
		checks: passed.sort((a, b) => a.code.localeCompare(b.code)),
		unverifiedPermissions,
	};
}
