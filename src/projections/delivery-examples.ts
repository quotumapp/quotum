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
): Pick<BillingProjectionInput, "billingAccountId" | "generatedAt" | "entitlements" | "balances"> {
	return {
		billingAccountId,
		generatedAt,
		entitlements: {
			billingAccountId,
			entitlements: entitlement === null ? [] : [{ key: "premium", ...entitlement }],
			generatedAt,
		},
		balances: [],
	};
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
 * One delivery per case a receiver handles for a Stripe subscription or one-time purchase,
 * published as `contracts/v1/projection-delivery.examples.json`. The integration lane checks each
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
			sequence: 3,
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
			sequence: 4,
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
};
