import type { SubscriptionStatus } from "../../billing/types";
import type {
	NormalizedStripeCommand,
	NormalizedStripeCreditReversalCommand,
	NormalizedStripeIgnoredCommand,
	NormalizedStripeSubscriptionCommand,
} from "./types";

interface NormalizeStripeCheckoutSessionInput {
	eventId: string;
	eventType?: string;
	eventCreated?: number;
	session: Record<string, unknown>;
}

interface NormalizeStripeRefundInput {
	eventId: string;
	eventType?: string;
	refund: Record<string, unknown>;
}

interface NormalizeStripeInvoiceInput {
	eventId: string;
	eventType: string;
	eventCreated?: number;
	invoice: Record<string, unknown>;
	now?: Date;
}

interface NormalizeStripeSubscriptionInput {
	eventId: string;
	eventType: string;
	eventCreated?: number;
	subscription: Record<string, unknown>;
	now?: Date;
	projectionReason?: "provider_webhook" | "provider_reconciliation";
}

interface NormalizeStripeDisputeInput {
	eventId: string;
	eventType?: string;
	dispute: Record<string, unknown>;
}

export function normalizeStripeCheckoutSession(
	input: NormalizeStripeCheckoutSessionInput,
): NormalizedStripeCommand {
	const eventType = input.eventType ?? "checkout.session.completed";
	const mode = requireString(input.session.mode, "Stripe Checkout session mode");
	const metadata = optionalRecord(input.session.metadata) ?? {};

	if (mode === "subscription") {
		const billingAccountId = requireString(
			metadata.billingAccountId,
			"Stripe Checkout session billing account id",
		);
		requireString(metadata.productKey, "Stripe Checkout session product key");
		requireString(metadata.purchaseKind, "Stripe Checkout session purchase kind");

		return {
			kind: "identity_only",
			billingAccountId,
			stripeCustomerId: requiredId(input.session.customer, "Stripe Checkout session customer"),
			eventType,
			externalEventId: input.eventId,
			rawPayload: input.session,
		};
	}

	if (mode !== "payment") {
		return ignored({
			eventId: input.eventId,
			eventType,
			rawPayload: input.session,
			reason: "checkout_session_unsupported_mode",
		});
	}

	if (optionalString(input.session.payment_status) !== "paid") {
		return ignored({
			eventId: input.eventId,
			eventType,
			rawPayload: input.session,
			reason: "payment_session_not_paid",
		});
	}

	requireString(metadata.productKey, "Stripe Checkout session product key");
	const purchaseKind = requireString(
		metadata.purchaseKind,
		"Stripe Checkout session purchase kind",
	);
	if (purchaseKind !== "consumable" && purchaseKind !== "non_consumable") {
		throw new Error("Stripe payment Checkout purchase kind is not supported");
	}
	const paymentIntent = optionalRecord(input.session.payment_intent);
	const paymentIntentId = requiredId(
		input.session.payment_intent,
		"Stripe Checkout session payment intent",
	);

	return {
		kind: "credit_purchase",
		purchaseKind,
		billingAccountId: requireString(
			metadata.billingAccountId,
			"Stripe Checkout session billing account id",
		),
		stripeCustomerId: optionalId(input.session.customer),
		externalProductId: requireString(
			metadata.externalProductId,
			"Stripe Checkout session product id",
		),
		externalPriceId: requireString(metadata.externalPriceId, "Stripe Checkout session price id"),
		paymentIntentId,
		chargeId:
			optionalId(input.session.charge) ??
			optionalId(paymentIntent?.latest_charge) ??
			optionalId(input.session.latest_charge),
		checkoutSessionId: requireString(input.session.id, "Stripe Checkout session id"),
		amountPaidCents:
			optionalNonnegativeInteger(input.session.amount_total) ??
			optionalNonnegativeInteger(paymentIntent?.amount),
		currency: optionalString(input.session.currency) ?? optionalString(paymentIntent?.currency),
		purchasedAt: dateFromStripeSeconds(
			input.session.created,
			"Stripe Checkout session created time",
		),
		rawPayload: input.session,
		eventType,
		externalEventId: input.eventId,
		projectionIdempotencyKey: `stripe:payment:${paymentIntentId}:projection`,
	};
}

export function normalizeStripeRefund(
	input: NormalizeStripeRefundInput,
): NormalizedStripeCreditReversalCommand | NormalizedStripeIgnoredCommand {
	const eventType = input.eventType ?? "refund.created";

	if (eventType === "charge.refunded") {
		return ignored({
			eventId: input.eventId,
			eventType,
			rawPayload: input.refund,
			reason: "charge_refunded_not_supported",
		});
	}

	if (eventType !== "refund.created" && eventType !== "refund.updated") {
		return ignored({
			eventId: input.eventId,
			eventType,
			rawPayload: input.refund,
			reason: "unsupported_refund_event_type",
		});
	}

	const status = requireString(input.refund.status, "Stripe refund status");

	if (status !== "succeeded") {
		return ignored({
			eventId: input.eventId,
			eventType,
			rawPayload: input.refund,
			reason: "refund_not_succeeded",
		});
	}

	const refundId = requireString(input.refund.id, "Stripe refund id");
	const charge = optionalRecord(input.refund.charge);
	const paymentIntentId = requiredId(input.refund.payment_intent, "Stripe refund payment intent");
	const reversalAmount = requireNonnegativeInteger(input.refund.amount, "Stripe refund amount");
	const reversalCurrency = requireString(input.refund.currency, "Stripe refund currency");

	return {
		kind: "credit_reversal",
		reversalReason: "refund",
		reversalId: refundId,
		billingAccountId: optionalString(optionalRecord(input.refund.metadata)?.billingAccountId),
		stripeCustomerId: optionalId(input.refund.customer) ?? optionalId(charge?.customer),
		paymentIntentId,
		chargeId: optionalId(input.refund.charge),
		reversalAmount,
		reversalCurrency: reversalCurrency.toLowerCase(),
		reversedAt: dateFromStripeSeconds(input.refund.created, "Stripe refund created time"),
		rawPayload: input.refund,
		eventType,
		externalEventId: input.eventId,
		projectionIdempotencyKey: `stripe:refund:${refundId}:reversal`,
	};
}

export function normalizeStripeInvoice(
	input: NormalizeStripeInvoiceInput,
): NormalizedStripeSubscriptionCommand | NormalizedStripeIgnoredCommand {
	const subscriptionId = invoiceSubscriptionId(input.invoice);
	if (subscriptionId === null) {
		return ignored({
			eventId: input.eventId,
			eventType: input.eventType,
			rawPayload: input.invoice,
			reason: "invoice_without_subscription",
		});
	}

	const metadata = optionalRecord(input.invoice.metadata) ?? {};
	const subscription = optionalRecord(input.invoice.subscription);
	const subscriptionMetadata = optionalRecord(subscription?.metadata) ?? {};
	const parentSubscriptionMetadata =
		optionalRecord(parentSubscriptionDetails(input.invoice)?.metadata) ?? {};
	const subscriptionLine = firstInvoiceSubscriptionLine(input.invoice, subscriptionId);
	const subscriptionLineMetadata = optionalRecord(subscriptionLine?.metadata) ?? {};
	const invoiceId = requireString(input.invoice.id, "Stripe invoice id");
	const status = requireString(input.invoice.status, "Stripe invoice status");
	const currentPeriodStart = invoiceStartsAt(input.invoice, subscriptionLine);
	const currentPeriodEnd = invoiceExpiresAt(input.invoice, subscriptionLine);
	const externalProductId =
		optionalString(metadata.externalProductId) ??
		optionalString(subscriptionLineMetadata.externalProductId) ??
		optionalString(parentSubscriptionMetadata.externalProductId) ??
		optionalString(subscriptionMetadata.externalProductId) ??
		invoiceLineProductId(subscriptionLine);
	const externalPriceId =
		optionalString(metadata.externalPriceId) ??
		optionalString(subscriptionLineMetadata.externalPriceId) ??
		optionalString(parentSubscriptionMetadata.externalPriceId) ??
		optionalString(subscriptionMetadata.externalPriceId) ??
		invoiceLinePriceId(subscriptionLine);

	return {
		kind: "subscription",
		billingAccountId:
			optionalString(metadata.billingAccountId) ??
			optionalString(subscriptionLineMetadata.billingAccountId) ??
			optionalString(parentSubscriptionMetadata.billingAccountId) ??
			optionalString(subscriptionMetadata.billingAccountId),
		stripeCustomerId: requiredId(input.invoice.customer, "Stripe invoice customer"),
		stripeSubscriptionId: subscriptionId,
		invoiceId,
		providerObjectIds: invoiceProviderObjectIds(input.invoice, invoiceId),
		externalProductId: requireString(externalProductId, "Stripe invoice product id"),
		externalPriceId: requireString(externalPriceId, "Stripe invoice price id"),
		items: [],
		subscriptionStatus: status === "paid" ? "active" : "billing_retry",
		providerStatus: status === "paid" ? "active" : "past_due",
		purchasedAt: dateFromStripeSeconds(input.invoice.created, "Stripe invoice created time"),
		currentPeriodStart,
		trialStart: null,
		trialEnd: null,
		expiresAt: currentPeriodEnd,
		cancelAtPeriodEnd: false,
		providerEventCreated: safeStripeEventCreated(input.eventCreated),
		invoiceStatus: status,
		invoiceAmountPaid: optionalNonnegativeInteger(input.invoice.amount_paid),
		invoiceCurrency: optionalString(input.invoice.currency)?.toLowerCase() ?? null,
		invoicePaidAt:
			status === "paid"
				? (optionalDateFromStripeSeconds(
						optionalRecord(input.invoice.status_transitions)?.paid_at,
					) ?? dateFromStripeSeconds(input.invoice.created, "Stripe invoice created time"))
				: null,
		autoRenew: true,
		rawPayload: input.invoice,
		eventType: input.eventType,
		externalEventId: input.eventId,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `stripe:invoice:${invoiceId}:${input.eventType}:${input.eventId}:projection`,
	};
}

export function normalizeStripeSubscription(
	input: NormalizeStripeSubscriptionInput,
): NormalizedStripeSubscriptionCommand {
	const subscriptionId = requireString(input.subscription.id, "Stripe subscription id");
	const status = requireString(input.subscription.status, "Stripe subscription status");
	const metadata = optionalRecord(input.subscription.metadata) ?? {};
	const now = input.now ?? new Date();
	const subscriptionItem = firstSubscriptionItem(input.subscription);
	const externalProductId = requireString(
		subscriptionItemProductId(subscriptionItem) ?? metadata.externalProductId,
		"Stripe subscription product id",
	);
	const externalPriceId = requireString(
		subscriptionItemPriceId(subscriptionItem) ?? metadata.externalPriceId,
		"Stripe subscription price id",
	);
	const expiresAt = subscriptionExpiresAt(input.subscription);
	const currentPeriodStart = subscriptionStartsAt(input.subscription);
	const subscriptionStatus = mapStripeSubscriptionStatus(status, expiresAt, now);
	const autoRenew = stripeSubscriptionAutoRenew(status, input.subscription);
	const projectionReason = input.projectionReason ?? "provider_webhook";

	return {
		kind: "subscription",
		billingAccountId: optionalString(metadata.billingAccountId),
		stripeCustomerId: requiredId(input.subscription.customer, "Stripe subscription customer"),
		stripeSubscriptionId: subscriptionId,
		invoiceId: optionalId(input.subscription.latest_invoice),
		providerObjectIds: invoiceProviderObjectIds(
			optionalRecord(input.subscription.latest_invoice) ?? {},
			optionalId(input.subscription.latest_invoice),
		),
		externalProductId,
		externalPriceId,
		items: normalizeSubscriptionItems(input.subscription),
		subscriptionStatus,
		providerStatus: normalizeStripeProviderStatus(status),
		purchasedAt: dateFromStripeSeconds(
			input.subscription.created,
			"Stripe subscription created time",
		),
		expiresAt,
		currentPeriodStart,
		trialStart: optionalDateFromStripeSeconds(input.subscription.trial_start),
		trialEnd: optionalDateFromStripeSeconds(input.subscription.trial_end),
		cancelAtPeriodEnd: optionalBoolean(input.subscription.cancel_at_period_end) === true,
		providerEventCreated: safeStripeEventCreated(input.eventCreated),
		invoiceStatus: null,
		invoiceAmountPaid: null,
		invoiceCurrency: null,
		invoicePaidAt: null,
		autoRenew,
		rawPayload: input.subscription,
		eventType: input.eventType,
		externalEventId: input.eventId,
		projectionReason,
		projectionIdempotencyKey: stripeSubscriptionProjectionIdempotencyKey({
			projectionReason,
			subscriptionId,
			eventType: input.eventType,
			eventId: input.eventId,
			externalProductId,
			externalPriceId,
			subscriptionStatus,
			expiresAt,
			autoRenew,
		}),
	};
}

export function normalizeStripeDispute(
	input: NormalizeStripeDisputeInput,
): NormalizedStripeCreditReversalCommand {
	const disputeId = requireString(input.dispute.id, "Stripe dispute id");
	const metadata = optionalRecord(input.dispute.metadata) ?? {};
	const charge = optionalRecord(input.dispute.charge);
	const reversalAmount = requireNonnegativeInteger(input.dispute.amount, "Stripe dispute amount");
	const reversalCurrency = requireString(input.dispute.currency, "Stripe dispute currency");
	const paymentIntentId =
		optionalString(metadata.paymentIntentId) ??
		optionalId(input.dispute.payment_intent) ??
		optionalId(input.dispute.paymentIntent) ??
		optionalId(charge?.payment_intent) ??
		optionalString(optionalRecord(charge?.metadata)?.paymentIntentId);

	return {
		kind: "credit_reversal",
		reversalReason: "dispute",
		reversalId: disputeId,
		billingAccountId: optionalString(metadata.billingAccountId),
		stripeCustomerId:
			optionalId(input.dispute.customer) ??
			optionalId(charge?.customer) ??
			optionalString(metadata.stripeCustomerId),
		paymentIntentId: requireString(paymentIntentId, "Stripe dispute payment intent id"),
		chargeId: optionalId(input.dispute.charge),
		reversalAmount,
		reversalCurrency: reversalCurrency.toLowerCase(),
		reversedAt: dateFromStripeSeconds(input.dispute.created, "Stripe dispute created time"),
		rawPayload: input.dispute,
		eventType: input.eventType ?? "charge.dispute.created",
		externalEventId: input.eventId,
		projectionIdempotencyKey: `stripe:dispute:${disputeId}:reversal`,
	};
}

function mapStripeSubscriptionStatus(
	status: string,
	expiresAt: Date | null,
	now: Date,
): SubscriptionStatus {
	switch (status) {
		case "active":
		case "trialing":
			return "active";
		case "past_due":
		case "incomplete":
		case "paused":
			return "billing_retry";
		case "canceled":
			if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
				return "expired";
			}
			return "cancelled";
		case "unpaid":
		case "incomplete_expired":
			return "expired";
		default:
			throw new Error(`Unsupported Stripe subscription status: ${status}`);
	}
}

function normalizeStripeProviderStatus(status: string): string {
	switch (status) {
		case "canceled":
			return "cancelled";
		case "incomplete":
		case "incomplete_expired":
		case "paused":
			return "unpaid";
		default:
			return status;
	}
}

function stripeSubscriptionAutoRenew(
	status: string,
	subscription: Record<string, unknown>,
): boolean {
	if (optionalBoolean(subscription.cancel_at_period_end) === true) {
		return false;
	}

	return status === "active" || status === "trialing" || status === "past_due";
}

function stripeSubscriptionProjectionIdempotencyKey(input: {
	projectionReason: "provider_webhook" | "provider_reconciliation";
	subscriptionId: string;
	eventType: string;
	eventId: string;
	externalProductId: string;
	externalPriceId: string;
	subscriptionStatus: SubscriptionStatus;
	expiresAt: Date | null;
	autoRenew: boolean;
}): string {
	if (input.projectionReason === "provider_webhook") {
		return `stripe:subscription:${input.subscriptionId}:${input.eventType}:${input.eventId}:projection`;
	}

	return [
		"stripe",
		"subscription",
		input.subscriptionId,
		"provider_reconciliation",
		input.externalProductId,
		input.externalPriceId,
		input.subscriptionStatus,
		"period_end",
		input.expiresAt?.toISOString() ?? "none",
		`auto_renew:${input.autoRenew}`,
		"projection",
	].join(":");
}

function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
	const lines = recordArray(optionalRecord(invoice.lines)?.data);

	return (
		optionalId(invoice.subscription) ??
		optionalId(parentSubscriptionDetails(invoice)?.subscription) ??
		lines.map((line) => invoiceLineSubscriptionId(line)).find((id) => id !== null) ??
		null
	);
}

function invoiceProviderObjectIds(
	invoice: Record<string, unknown>,
	invoiceId: string | null,
): string[] {
	const ids = new Set<string>();
	const add = (value: unknown) => {
		const id = optionalId(value);
		if (id !== null) {
			ids.add(id);
		}
	};
	add(invoiceId);
	add(invoice.payment_intent);
	add(invoice.charge);
	add(optionalRecord(invoice.payment_intent)?.latest_charge);

	for (const invoicePayment of recordArray(optionalRecord(invoice.payments)?.data)) {
		const payment = optionalRecord(invoicePayment.payment);
		add(payment?.payment_intent);
		add(payment?.charge);
		add(optionalRecord(payment?.payment_intent)?.latest_charge);
	}
	return [...ids];
}

function parentSubscriptionDetails(
	invoice: Record<string, unknown>,
): Record<string, unknown> | null {
	return optionalRecord(optionalRecord(invoice.parent)?.subscription_details);
}

function firstInvoiceSubscriptionLine(
	invoice: Record<string, unknown>,
	subscriptionId: string,
): Record<string, unknown> | null {
	const lines = recordArray(optionalRecord(invoice.lines)?.data);
	const currentSubscriptionItemLine = lines.find(
		(line) => invoiceLineCurrentSubscriptionItemId(line) === subscriptionId,
	);

	if (currentSubscriptionItemLine !== undefined) {
		return currentSubscriptionItemLine;
	}

	const legacySubscriptionLine = lines.find(
		(line) =>
			invoiceLineCurrentSubscriptionItemId(line) === null &&
			isLegacyRecurringSubscriptionLine(line) &&
			optionalId(line.subscription) === subscriptionId,
	);

	if (legacySubscriptionLine !== undefined) {
		return legacySubscriptionLine;
	}

	const lineWithPeriodEnd = lines.find((line) => {
		const period = optionalRecord(line.period);
		return (
			!isInvoiceItemLine(line) && typeof period?.end === "number" && Number.isFinite(period.end)
		);
	});

	return lineWithPeriodEnd ?? lines.find((line) => !isInvoiceItemLine(line)) ?? null;
}

function invoiceExpiresAt(
	invoice: Record<string, unknown>,
	subscriptionLine: Record<string, unknown> | null,
): Date | null {
	const subscriptionLinePeriodEnd = optionalRecord(subscriptionLine?.period)?.end;
	if (typeof subscriptionLinePeriodEnd === "number" && Number.isFinite(subscriptionLinePeriodEnd)) {
		return dateFromStripeSeconds(subscriptionLinePeriodEnd, "Stripe invoice line period end");
	}

	const linePeriodEnds = recordArray(optionalRecord(invoice.lines)?.data)
		.filter((line) => !isInvoiceItemLine(line))
		.map((line) => optionalRecord(line.period)?.end)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

	if (linePeriodEnds.length > 0) {
		return dateFromStripeSeconds(Math.max(...linePeriodEnds), "Stripe invoice line period end");
	}

	return optionalDateFromStripeSeconds(optionalRecord(invoice.subscription)?.current_period_end);
}

function invoiceStartsAt(
	invoice: Record<string, unknown>,
	subscriptionLine: Record<string, unknown> | null,
): Date | null {
	const subscriptionLinePeriodStart = optionalRecord(subscriptionLine?.period)?.start;
	if (
		typeof subscriptionLinePeriodStart === "number" &&
		Number.isFinite(subscriptionLinePeriodStart)
	) {
		return dateFromStripeSeconds(subscriptionLinePeriodStart, "Stripe invoice line period start");
	}

	const linePeriodStarts = recordArray(optionalRecord(invoice.lines)?.data)
		.filter((line) => !isInvoiceItemLine(line))
		.map((line) => optionalRecord(line.period)?.start)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

	return linePeriodStarts.length === 0
		? null
		: dateFromStripeSeconds(Math.min(...linePeriodStarts), "Stripe invoice line period start");
}

function invoiceLineSubscriptionId(line: Record<string, unknown>): string | null {
	const parent = optionalRecord(line.parent);

	return (
		optionalId(line.subscription) ??
		invoiceLineCurrentSubscriptionItemId(line) ??
		optionalId(optionalRecord(parent?.invoice_item_details)?.subscription)
	);
}

function isLegacyRecurringSubscriptionLine(line: Record<string, unknown>): boolean {
	const lineType = optionalString(line.type);
	return lineType === null || lineType === "subscription";
}

function isInvoiceItemLine(line: Record<string, unknown>): boolean {
	const lineType = optionalString(line.type);
	const parent = optionalRecord(line.parent);
	const hasInvoiceItemParent = optionalRecord(parent?.invoice_item_details) !== null;
	const hasSubscriptionItemParent = optionalRecord(parent?.subscription_item_details) !== null;

	return lineType === "invoiceitem" || (hasInvoiceItemParent && !hasSubscriptionItemParent);
}

function invoiceLineCurrentSubscriptionItemId(line: Record<string, unknown>): string | null {
	return optionalId(
		optionalRecord(optionalRecord(line.parent)?.subscription_item_details)?.subscription,
	);
}

function invoiceLineProductId(line: Record<string, unknown> | null): string | null {
	if (line === null) {
		return null;
	}

	const price = optionalRecord(line.price);
	const pricingDetails = optionalRecord(optionalRecord(line.pricing)?.price_details);

	return (
		optionalId(price?.product) ??
		optionalId(pricingDetails?.product) ??
		optionalId(optionalRecord(line.plan)?.product)
	);
}

function invoiceLinePriceId(line: Record<string, unknown> | null): string | null {
	if (line === null) {
		return null;
	}

	const price = optionalRecord(line.price);
	const pricingDetails = optionalRecord(optionalRecord(line.pricing)?.price_details);

	return optionalId(price) ?? optionalId(pricingDetails?.price) ?? optionalId(line.plan);
}

function firstSubscriptionItem(
	subscription: Record<string, unknown>,
): Record<string, unknown> | null {
	const items = recordArray(optionalRecord(subscription.items)?.data);
	return (
		items.find(
			(item) => subscriptionItemProductId(item) !== null && subscriptionItemPriceId(item) !== null,
		) ??
		items[0] ??
		null
	);
}

function normalizeSubscriptionItems(subscription: Record<string, unknown>) {
	return recordArray(optionalRecord(subscription.items)?.data).flatMap((item) => {
		const providerSubscriptionItemId = optionalId(item.id);
		const externalProductId = subscriptionItemProductId(item);
		const externalPriceId = subscriptionItemPriceId(item);
		const quantity = optionalNonnegativeInteger(item.quantity) ?? 1;
		if (
			providerSubscriptionItemId === null ||
			externalProductId === null ||
			externalPriceId === null ||
			quantity < 1
		) {
			return [];
		}
		return [{ providerSubscriptionItemId, externalProductId, externalPriceId, quantity }];
	});
}

function subscriptionItemProductId(item: Record<string, unknown> | null): string | null {
	return invoiceLineProductId(item);
}

function subscriptionItemPriceId(item: Record<string, unknown> | null): string | null {
	return invoiceLinePriceId(item);
}

function subscriptionExpiresAt(subscription: Record<string, unknown>): Date | null {
	const topLevelPeriodEnd = optionalDateFromStripeSeconds(subscription.current_period_end);
	if (topLevelPeriodEnd !== null) {
		return topLevelPeriodEnd;
	}

	const itemPeriodEnds = recordArray(optionalRecord(subscription.items)?.data)
		.map((item) => item.current_period_end)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

	if (itemPeriodEnds.length === 0) {
		return null;
	}

	return dateFromStripeSeconds(Math.max(...itemPeriodEnds), "Stripe subscription item period end");
}

function subscriptionStartsAt(subscription: Record<string, unknown>): Date | null {
	const topLevelPeriodStart = optionalDateFromStripeSeconds(subscription.current_period_start);
	if (topLevelPeriodStart !== null) {
		return topLevelPeriodStart;
	}

	const itemPeriodStarts = recordArray(optionalRecord(subscription.items)?.data)
		.map((item) => item.current_period_start)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

	return itemPeriodStarts.length === 0
		? null
		: dateFromStripeSeconds(Math.min(...itemPeriodStarts), "Stripe subscription item period start");
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} is required`);
	}

	return value;
}

function requireNonnegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${name} is required`);
	}

	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a nonnegative integer`);
	}

	return value;
}

function optionalNonnegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeStripeEventCreated(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	return value as Record<string, unknown>;
}

function recordArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is Record<string, unknown> => optionalRecord(item) !== null);
}

function optionalBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function dateFromStripeSeconds(value: unknown, name: string): Date {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${name} is required`);
	}

	return new Date(value * 1000);
}

function optionalDateFromStripeSeconds(value: unknown): Date | null {
	if (value === undefined || value === null) {
		return null;
	}

	return dateFromStripeSeconds(value, "Stripe timestamp");
}

function requiredId(value: unknown, name: string): string {
	const id = optionalId(value);
	if (id === null) {
		throw new Error(`${name} is required`);
	}

	return id;
}

function optionalId(value: unknown): string | null {
	return optionalString(value) ?? optionalString(optionalRecord(value)?.id);
}

function ignored(input: {
	eventId: string;
	eventType: string;
	rawPayload: Record<string, unknown>;
	reason: string;
}): NormalizedStripeIgnoredCommand {
	return {
		kind: "ignored",
		reason: input.reason,
		eventType: input.eventType,
		externalEventId: input.eventId,
		rawPayload: input.rawPayload,
	};
}
