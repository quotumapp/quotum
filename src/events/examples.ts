import { type DomainEventEnvelope, webhookTestEventType } from "./types";

export interface DomainEventExample {
	description: string;
	event: DomainEventEnvelope;
}

const projectKey = "acme";
const billingAccountId = "user_42";
const subscriptionId = "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e01";
const externalSubscriptionId = "sub_1QZ8xExampleAcme";

function event(
	id: string,
	type: string,
	occurredAt: string,
	data: Record<string, unknown>,
	options: { account?: boolean; environment?: DomainEventEnvelope["environment"] } = {},
): DomainEventEnvelope {
	return {
		id,
		type,
		version: 1,
		createdAt: occurredAt,
		occurredAt,
		environment: options.environment ?? "production",
		projectKey,
		...(options.account === false ? {} : { billingAccountId }),
		data,
	};
}

const subscription = {
	id: subscriptionId,
	externalSubscriptionId,
	provider: "stripe",
	channel: "web",
	productKey: "pro_monthly",
	status: "active",
	providerStatus: "active",
	startsAt: "2026-10-01T09:30:00.000Z",
	expiresAt: "2026-11-01T09:30:00.000Z",
	currentPeriodStart: "2026-10-01T09:30:00.000Z",
	currentPeriodEnd: "2026-11-01T09:30:00.000Z",
	cancelAtPeriodEnd: false,
	autoRenew: true,
};

const projectedSubscription = {
	subscriptionId,
	externalSubscriptionId,
	provider: "stripe",
	channel: "web",
	productKey: "pro_monthly",
	planKey: "pro",
	status: "active",
	providerStatus: "active",
	expiresAt: "2026-11-01T09:30:00.000Z",
	cancelAtPeriodEnd: false,
	cancellationReason: null,
};

const autoTopup = {
	jobId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e40",
	policyId: "11",
	featureKey: "ai_credits",
	topupKey: "credits_100",
	entityId: null,
	provider: "stripe",
	amountMinor: 499,
	chargedAmountMinor: null,
	currency: "usd",
	externalInvoiceId: null,
	externalPaymentId: null,
	error: null,
};

/**
 * One example per event type, rendered to `contracts/v1/domain-events.examples.json` and validated
 * against the schema by the contract test.
 */
export const domainEventExamples: DomainEventExample[] = [
	{
		description: "A test delivery an operator requested for one endpoint.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
			webhookTestEventType,
			"2026-10-19T08:00:00.000Z",
			{
				endpointId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20",
				message: "A test delivery from Quotum",
			},
			{ account: false, environment: "sandbox" },
		),
	},
	{
		description: "A new Stripe subscription starts granting access.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e11",
			"subscription.activated",
			"2026-10-01T09:30:05.000Z",
			{
				subscription,
				previousAttributes: {},
			},
		),
	},
	{
		description: "The customer scheduled the subscription to cancel at the end of the period.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e12",
			"subscription.updated",
			"2026-10-12T14:02:11.000Z",
			{
				subscription: {
					...subscription,
					status: "cancelled",
					cancelAtPeriodEnd: true,
					autoRenew: false,
				},
				previousAttributes: { status: "active", cancelAtPeriodEnd: false, autoRenew: true },
			},
		),
	},
	{
		description: "The subscription expired at the end of its last paid period.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e13",
			"subscription.ended",
			"2026-11-01T09:31:00.000Z",
			{
				subscription: {
					...subscription,
					status: "expired",
					cancelAtPeriodEnd: true,
					autoRenew: false,
				},
				previousAttributes: { status: "cancelled", autoRenew: true },
			},
		),
	},
	{
		description: "Stripe reports a subscription invoice as paid.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e14",
			"invoice.paid",
			"2026-10-01T09:30:02.000Z",
			{
				invoice: {
					id: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e50",
					externalInvoiceId: "in_1QZ8xExampleAcme",
					provider: "stripe",
					status: "paid",
					amountPaidMinor: 2000,
					currency: "usd",
					paidAt: "2026-10-01T09:30:01.000Z",
					subscriptionId,
					externalSubscriptionId,
				},
			},
		),
	},
	{
		description: "Stripe reports that charging a subscription invoice failed.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e15",
			"invoice.payment_failed",
			"2026-11-01T09:30:04.000Z",
			{
				invoice: {
					id: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e51",
					externalInvoiceId: "in_1QZ9xExampleAcme",
					provider: "stripe",
					status: "open",
					amountPaidMinor: 0,
					currency: "usd",
					paidAt: null,
					subscriptionId,
					externalSubscriptionId,
				},
			},
		),
	},
	{
		description: "A subscription payment was refunded; the credits it funded are taken back.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e16",
			"refund.recorded",
			"2026-10-05T11:00:00.000Z",
			{
				reversal: {
					provider: "stripe",
					channel: "web",
					reason: "refund",
					transactionId: "re_1QZ8xExampleAcme",
					originalTransactionId: "in_1QZ8xExampleAcme",
					productKey: "pro_monthly",
					creditAmount: 0,
					reversedAt: "2026-10-05T11:00:00.000Z",
				},
				subscription: projectedSubscription,
			},
		),
	},
	{
		description: "The customer disputed a credit pack payment.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e17",
			"dispute.recorded",
			"2026-10-07T16:20:00.000Z",
			{
				reversal: {
					provider: "stripe",
					channel: "web",
					reason: "dispute",
					transactionId: "dp_1QZ8xExampleAcme",
					originalTransactionId: "pi_1QZ8xExampleAcme",
					productKey: "credits_100",
					creditAmount: 100,
					totalCreditAmount: 100,
					reversedAt: "2026-10-07T16:20:00.000Z",
				},
			},
		),
	},
	{
		description: "A Stripe trial ends in three days.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e18",
			"trial.ending",
			"2026-10-12T09:30:00.000Z",
			{
				trial: {
					event: "ending",
					source: "subscription",
					provider: "stripe",
					channel: "web",
					externalSubscriptionId,
					productKey: "pro_monthly",
					trialStartsAt: "2026-10-01T09:30:00.000Z",
					trialEndsAt: "2026-10-15T09:30:00.000Z",
					autoRenew: true,
				},
			},
		),
	},
	{
		description: "A trial Quotum ran ended without a paid plan after it.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e19",
			"trial.ended",
			"2026-10-15T09:30:00.000Z",
			{
				trial: {
					event: "ended",
					source: "plan_grant",
					planGrantId: "0192f3a1-9a00-7c00-8d00-0e0f10111213",
					planKey: "pro",
					trialStartsAt: "2026-10-01T09:30:00.000Z",
					trialEndsAt: "2026-10-15T09:30:00.000Z",
					autoRenew: false,
				},
			},
		),
	},
	{
		description: "The plan a redeemed promotion code gave ends in three days.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e1a",
			"plan_grant.ending",
			"2026-10-28T09:30:00.000Z",
			{
				planGrant: {
					event: "ending",
					origin: "promotion",
					planGrantId: "0192f3a1-9a00-7c00-8d00-0e0f10111214",
					planKey: "pro",
					promotionRedemptionId: "0192f3a1-9a00-7c00-8d00-0e0f10111215",
					startsAt: "2026-10-01T09:30:00.000Z",
					endsAt: "2026-10-31T09:30:00.000Z",
				},
			},
		),
	},
	{
		description: "The plan a redeemed promotion code gave has ended.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e1b",
			"plan_grant.ended",
			"2026-10-31T09:30:00.000Z",
			{
				planGrant: {
					event: "ended",
					origin: "promotion",
					planGrantId: "0192f3a1-9a00-7c00-8d00-0e0f10111214",
					planKey: "pro",
					promotionRedemptionId: "0192f3a1-9a00-7c00-8d00-0e0f10111215",
					startsAt: "2026-10-01T09:30:00.000Z",
					endsAt: "2026-10-31T09:30:00.000Z",
				},
			},
		),
	},
	{
		description: "Usage reached 80% of the month's usage limit.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e1c",
			"usage_alert.triggered",
			"2026-10-20T13:45:12.000Z",
			{
				alert: {
					id: "42",
					featureKey: "ai_credits",
					entityId: null,
					thresholdType: "percentage",
					thresholdValue: "80",
					interval: "month",
					intervalCount: 1,
				},
				window: { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z" },
				threshold: "800",
				currentValue: "812",
				crossing: 1,
			},
		),
	},
	{
		description: "An automatic top-up charged the saved card and added the credits.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e1d",
			"auto_topup.succeeded",
			"2026-10-20T13:45:40.000Z",
			{
				autoTopup: {
					...autoTopup,
					chargedAmountMinor: 499,
					externalInvoiceId: "in_1QZAxExampleAcme",
					externalPaymentId: "pi_1QZAxExampleAcme",
				},
			},
		),
	},
	{
		description: "An automatic top-up failed for good; the policy is suspended until it is reset.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e1e",
			"auto_topup.failed",
			"2026-10-21T08:10:00.000Z",
			{
				autoTopup: { ...autoTopup, error: "Your card was declined." },
			},
		),
	},
	{
		description: "An automatic top-up needs the customer, here a purchase in the App Store.",
		event: event(
			"0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e1f",
			"auto_topup.action_required",
			"2026-10-21T08:10:00.000Z",
			{
				autoTopup: {
					...autoTopup,
					provider: "apple",
					amountMinor: 0,
					currency: null,
					error: "Provider-native purchase action is required",
				},
			},
		),
	},
];
