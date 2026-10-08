import type { ProjectionSubscriptionPayload } from "../billing/types";
import type { BillingProjectionInput } from "./delivery";

export interface ProjectionDeliveryExample {
	description: string;
	delivery: BillingProjectionInput;
}

const projectKey = "acme";
const billingAccountId = "user_42";
const subscriptionId = "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e01";
const externalSubscriptionId = "sub_1QZ8xExampleAcme";

function snapshot(
	generatedAt: string,
	entitlement: { active: boolean; expiresAt: string; metadata: Record<string, unknown> } | null,
	balances: BillingProjectionInput["balances"] = [],
): Pick<BillingProjectionInput, "billingAccountId" | "generatedAt" | "entitlements" | "balances"> {
	return {
		billingAccountId,
		generatedAt,
		entitlements: {
			billingAccountId,
			entitlements: entitlement === null ? [] : [{ key: "premium", ...entitlement }],
			generatedAt,
		},
		balances,
	};
}

/** A store subscription's entitlement source: the same fields, with the store's own identifiers. */
function storeSubscriptionSource(store: {
	provider: "apple" | "google";
	channel: "ios" | "android";
	subscriptionId: string;
	externalSubscriptionId: string;
}) {
	return { ...subscriptionSource("active"), ...store };
}

function subscriptionSource(status: string, trial: Record<string, string> = {}) {
	return {
		source: "subscription",
		status,
		channel: "web",
		planKey: null,
		provider: "stripe",
		productId: "0192f3a1-6b2d-7f40-8c11-2e3f4a5b6c7d",
		productKey: "premium_monthly",
		...trial,
		storeProductId: "0192f3a1-6b9f-7a52-b3c4-d5e6f7a8b9c0",
		subscriptionId,
		externalSubscriptionId,
	};
}

function subscription(
	overrides: Partial<ProjectionSubscriptionPayload> = {},
): ProjectionSubscriptionPayload {
	return {
		subscriptionId,
		externalSubscriptionId,
		provider: "stripe",
		channel: "web",
		productKey: "premium_monthly",
		planKey: null,
		status: "active",
		providerStatus: "active",
		expiresAt: "2026-11-01T09:30:00.000Z",
		cancelAtPeriodEnd: false,
		cancellationReason: null,
		...overrides,
	};
}

const subscriptionKey = (eventType: string, eventId: string) =>
	`stripe:subscription:${externalSubscriptionId}:${eventType}:${eventId}:projection`;

const trial = {
	trialStartsAt: "2026-10-01T09:30:00.000Z",
	trialEndsAt: "2026-10-15T09:30:00.000Z",
};

/**
 * One delivery per case a receiver handles: a Stripe subscription or one-time purchase, a verified
 * App Store or Google Play purchase, and a usage snapshot. Published as
 * `contracts/v1/projection-delivery.examples.json`. The integration lane checks each
 * against the delivery the real flow produces, so add a case there with its example here. That
 * flow's subscription is not on a catalog plan, hence `planKey: null`; one that is carries its
 * pinned plan's key there, in the entitlement metadata and in the trial fact.
 */
export const projectionDeliveryExamples: Record<string, ProjectionDeliveryExample> = {
	stripe_subscription_purchase: {
		description:
			"A new Stripe subscription is active after checkout. Deliveries about a subscription carry the subscription fact and no purchase fact. planKey is null here because this subscription is not on a catalog plan; one that is carries its pinned plan's key.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0001-7a10-8b20-c30d40e50f60",
			idempotencyKey: subscriptionKey("customer.subscription.created", "evt_1QZ8yCreated"),
			...snapshot("2026-10-01T09:30:02.114Z", {
				active: true,
				expiresAt: "2026-11-01T09:30:00.000Z",
				metadata: subscriptionSource("active"),
			}),
			reason: "provider_webhook",
			subscription: subscription(),
			sequence: 1,
		},
	},
	stripe_subscription_renewal: {
		description:
			"The subscription renewed: the entitlement and the subscription fact carry the new period end.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0002-7a10-8b20-c30d40e50f60",
			idempotencyKey: subscriptionKey("customer.subscription.updated", "evt_1QaJ2Renewed"),
			...snapshot("2026-11-01T09:30:04.870Z", {
				active: true,
				expiresAt: "2026-12-01T09:30:00.000Z",
				metadata: subscriptionSource("active"),
			}),
			reason: "provider_webhook",
			subscription: subscription({ expiresAt: "2026-12-01T09:30:00.000Z" }),
			sequence: 2,
		},
	},
	stripe_subscription_refund: {
		description:
			"A payment of the subscription was refunded. Stripe keeps the subscription running, so nothing is revoked: the reversal carries creditAmount 0, names the refund and the payment intent, and arrives with the subscription fact. Cancel the subscription to end access.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0009-7a10-8b20-c30d40e50f60",
			idempotencyKey: "stripe:refund:re_3QaK4ExampleAcme:reversal",
			...snapshot("2026-11-03T10:15:42.207Z", {
				active: true,
				expiresAt: "2026-12-01T09:30:00.000Z",
				metadata: subscriptionSource("active"),
			}),
			reason: "provider_webhook",
			reversal: {
				provider: "stripe",
				channel: "web",
				reason: "refund",
				transactionId: "re_3QaK4ExampleAcme",
				originalTransactionId: "pi_3QaJ2ExampleAcme",
				productKey: "premium_monthly",
				creditAmount: 0,
				reversedAt: "2026-11-03T10:15:40.000Z",
			},
			subscription: subscription({ expiresAt: "2026-12-01T09:30:00.000Z" }),
			sequence: 3,
		},
	},
	stripe_subscription_cancel_scheduled: {
		description:
			"The customer cancelled at period end. Access continues: status stays active, and cancelAtPeriodEnd and cancellationReason explain the pending end.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0003-7a10-8b20-c30d40e50f60",
			idempotencyKey: subscriptionKey("customer.subscription.updated", "evt_1QbT5CancelSet"),
			...snapshot("2026-11-12T16:02:41.305Z", {
				active: true,
				expiresAt: "2026-12-01T09:30:00.000Z",
				metadata: subscriptionSource("active"),
			}),
			reason: "provider_webhook",
			subscription: subscription({
				expiresAt: "2026-12-01T09:30:00.000Z",
				cancelAtPeriodEnd: true,
				cancellationReason: "cancellation_requested",
			}),
			sequence: 4,
		},
	},
	stripe_subscription_ended: {
		description:
			"The subscription ended. The entitlement is inactive and keeps its last source, whose status says why it stopped.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0004-7a10-8b20-c30d40e50f60",
			idempotencyKey: subscriptionKey("customer.subscription.deleted", "evt_1QcV8Deleted"),
			...snapshot("2026-12-01T09:30:03.552Z", {
				active: false,
				expiresAt: "2026-12-01T09:30:00.000Z",
				metadata: subscriptionSource("expired"),
			}),
			reason: "provider_webhook",
			subscription: subscription({
				status: "expired",
				providerStatus: "cancelled",
				expiresAt: "2026-12-01T09:30:00.000Z",
				cancellationReason: "cancellation_requested",
			}),
			sequence: 5,
		},
	},
	stripe_trial_started: {
		description:
			"A Stripe subscription started with a trial. status is active while providerStatus is trialing, and the entitlement metadata carries the trial bounds.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0005-7a10-8b20-c30d40e50f60",
			idempotencyKey: subscriptionKey("customer.subscription.created", "evt_1QZ8yTrialing"),
			...snapshot("2026-10-01T09:30:02.114Z", {
				active: true,
				expiresAt: trial.trialEndsAt,
				metadata: subscriptionSource("active", trial),
			}),
			reason: "provider_webhook",
			subscription: subscription({ providerStatus: "trialing", expiresAt: trial.trialEndsAt }),
			sequence: 1,
		},
	},
	stripe_trial_ending: {
		description:
			"The trial ends in about three days (customer.subscription.trial_will_end). Record the trial fact once by its key; it arrives once per trial end.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0006-7a10-8b20-c30d40e50f60",
			idempotencyKey: subscriptionKey(
				"customer.subscription.trial_will_end",
				"evt_1QZq3TrialWillEnd",
			),
			...snapshot("2026-10-12T09:30:01.008Z", {
				active: true,
				expiresAt: trial.trialEndsAt,
				metadata: subscriptionSource("active", trial),
			}),
			reason: "provider_webhook",
			trial: {
				event: "ending",
				source: "subscription",
				provider: "stripe",
				channel: "web",
				externalSubscriptionId,
				productKey: "premium_monthly",
				...trial,
				autoRenew: true,
			},
			subscription: subscription({ providerStatus: "trialing", expiresAt: trial.trialEndsAt }),
			sequence: 2,
		},
	},
	stripe_one_time_purchase: {
		description:
			"A one-time Stripe Checkout purchase of a credit pack. Record the purchase fact once by transactionId, the payment intent.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0007-7a10-8b20-c30d40e50f60",
			idempotencyKey: "stripe:payment:pi_3QZ9aExampleAcme:projection",
			...snapshot("2026-10-03T14:11:27.640Z", null),
			reason: "provider_webhook",
			purchase: {
				provider: "stripe",
				channel: "web",
				purchaseKind: "consumable",
				transactionId: "pi_3QZ9aExampleAcme",
				productKey: "credits_10",
				creditAmount: 10,
				totalCreditAmount: 10,
				quantity: 1,
				purchasedAt: "2026-10-03T14:11:25.000Z",
			},
			sequence: 1,
		},
	},
	stripe_one_time_refund: {
		description:
			"That purchase was refunded in full. The reversal names the refund as transactionId and the purchase's payment intent as originalTransactionId; creditAmount is what this refund takes back.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-0008-7a10-8b20-c30d40e50f60",
			idempotencyKey: "stripe:refund:re_3QZ9aExampleAcme:reversal",
			...snapshot("2026-10-05T08:45:10.921Z", null),
			reason: "provider_webhook",
			reversal: {
				provider: "stripe",
				channel: "web",
				reason: "refund",
				transactionId: "re_3QZ9aExampleAcme",
				originalTransactionId: "pi_3QZ9aExampleAcme",
				productKey: "credits_10",
				creditAmount: 10,
				totalCreditAmount: 10,
				quantity: 1,
				reversedAt: "2026-10-05T08:45:08.000Z",
			},
			sequence: 2,
		},
	},
	apple_subscription_purchase: {
		description:
			"An App Store subscription verified through POST /v1/purchases/verify. A store subscription carries no purchase or subscription fact: its state is the entitlement, whose metadata names the provider, the channel and the original transaction as externalSubscriptionId.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-000a-7a10-8b20-c30d40e50f60",
			idempotencyKey: "apple:2000000912345678:purchase_verified",
			...snapshot("2026-10-01T09:30:02.114Z", {
				active: true,
				expiresAt: "2026-11-01T09:30:00.000Z",
				metadata: storeSubscriptionSource({
					provider: "apple",
					channel: "ios",
					subscriptionId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e02",
					externalSubscriptionId: "2000000912345000",
				}),
			}),
			reason: "purchase_verified",
			sequence: 1,
		},
	},
	google_subscription_purchase: {
		description:
			"A Google Play subscription verified through POST /v1/purchases/verify. Like the App Store case it carries no fact; externalSubscriptionId is the purchase token.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-000b-7a10-8b20-c30d40e50f60",
			idempotencyKey: "google:kpfnmhdbajcoelgi.AO-J1OxExampleToken:purchase_verified",
			...snapshot("2026-10-01T09:30:02.114Z", {
				active: true,
				expiresAt: "2026-11-01T09:30:00.000Z",
				metadata: storeSubscriptionSource({
					provider: "google",
					channel: "android",
					subscriptionId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e03",
					externalSubscriptionId: "kpfnmhdbajcoelgi.AO-J1OxExampleToken",
				}),
			}),
			reason: "purchase_verified",
			sequence: 1,
		},
	},
	google_consumable_purchase: {
		description:
			"A Google Play consumable verified through POST /v1/purchases/verify. Record the purchase fact once by transactionId, the purchase token; refundableQuantity is how many of its units a refund can still take back.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-000c-7a10-8b20-c30d40e50f60",
			idempotencyKey: "google:bmcedkfnhiajoplg.AO-J1OyExampleToken:purchase_verified",
			...snapshot("2026-10-03T14:11:27.640Z", null),
			reason: "purchase_verified",
			purchase: {
				provider: "google",
				channel: "android",
				purchaseKind: "consumable",
				transactionId: "bmcedkfnhiajoplg.AO-J1OyExampleToken",
				productKey: "credits_10",
				creditAmount: 10,
				totalCreditAmount: 10,
				quantity: 1,
				refundableQuantity: 1,
				purchasedAt: "2026-10-03T14:11:25.000Z",
			},
			sequence: 1,
		},
	},
	usage_snapshot: {
		description:
			"Metered usage changed the account's balances. One delivery covers every consume, reservation and confirmation since the previous one. Its key is usage:<customerId>:<sequence>, and a retry repeats the same key and body. Balances are exact decimal strings.",
		delivery: {
			schemaVersion: 1,
			projectKey,
			jobId: "0192f3a2-000d-7a10-8b20-c30d40e50f60",
			idempotencyKey: "usage:0192f3a1-5d10-7e22-9f33-4a5b6c7d8e9f:7",
			...snapshot("2026-10-04T18:20:11.305Z", null, [
				{
					featureKey: "ai_credits",
					unit: "credit",
					available: "9.5",
					held: "0",
					periodEndsAt: null,
				},
			]),
			reason: "usage_changed",
			sequence: 7,
		},
	},
};
