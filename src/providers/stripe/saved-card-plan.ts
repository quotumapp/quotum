/**
 * Starts a published plan on the card a hosted setup just saved. The routine is deliberately not
 * tied to setup: a later call can charge a card that is already the account default.
 *
 * A declined payment or one that needs authentication creates no local subscription. The card
 * stays saved and the plan outcome is `payment_failed`. Any other provider failure is left to the
 * caller's retry. A subscription Stripe already created for this setup is adopted, including after
 * the idempotency key has expired.
 */

import type Stripe from "stripe";
import { BillingError, isBillingError } from "../../billing/errors";
import type { PaymentSetupPlanStatus } from "../../billing/payment-setup";
import type {
	PaymentSetupRow,
	RecordPaymentSetupPlanOutcomeInput,
	StripeRecurringCheckoutPlan,
} from "../../db/repository";

/** Codes an eligibility or catalog check may leave on the setup instead of retrying. */
const PLAN_OUTCOME_CODES = new Set([
	"ADDON_REQUIRES_BASE_PLAN",
	"BASE_PLAN_ALREADY_ACTIVE",
	"BILLING_PLAN_NOT_FOUND",
	"INVALID_QUANTITY",
	"INVALID_REQUEST",
	"QUANTITY_REQUIRED",
]);

const SUCCESSFUL_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export interface SavedCardPlanClient {
	createSubscription(
		params: Stripe.SubscriptionCreateParams,
		idempotencyKey: string,
	): Promise<Record<string, unknown>>;
	listCustomerSubscriptions(customerId: string): Promise<Array<Record<string, unknown>>>;
	retrieveSubscription(subscriptionId: string): Promise<unknown>;
}

export interface SavedCardPlanRepository {
	getStripeRecurringCheckoutPlanByKey(
		planKey: string,
		billingAccountId: string,
	): Promise<StripeRecurringCheckoutPlan>;
	hasActiveBasePlan(billingAccountId: string): Promise<boolean>;
	recordPaymentSetupSubscriptionId(input: {
		setupId: string;
		workerId: string;
		externalSubscriptionId: string;
	}): Promise<PaymentSetupRow>;
	recordPaymentSetupPlanOutcome(
		input: RecordPaymentSetupPlanOutcomeInput,
	): Promise<PaymentSetupRow>;
}

export interface SavedCardPlanContext {
	client: SavedCardPlanClient;
	repository: SavedCardPlanRepository;
	subscriptionCreateParams(
		plan: StripeRecurringCheckoutPlan,
		quantities: Record<string, number>,
		setup: PaymentSetupRow,
	): Stripe.SubscriptionCreateParams;
	recordSubscription(subscription: Record<string, unknown>): Promise<void>;
}

/** The provider idempotency key for one setup's subscription, stable across retries. */
export function paymentSetupPlanIdempotencyKey(setupId: string): string {
	return `billing:payment-setup-plan:${setupId}`;
}

/**
 * Refuses a plan a saved-card charge cannot start. An add-on needs a base plan. A second base plan
 * has to go through `subscription_change`, because this charge has no hosted page that can replace one.
 */
export function assertSetupPlanEligible(
	plan: StripeRecurringCheckoutPlan,
	hasActiveBasePlan: boolean,
): void {
	if (plan.kind === "addon" && !hasActiveBasePlan) {
		throw new BillingError(
			"An active base plan is required before purchasing an add-on",
			"ADDON_REQUIRES_BASE_PLAN",
			409,
		);
	}
	if (plan.kind === "base" && hasActiveBasePlan) {
		throw new BillingError(
			"This billing account already has an active base plan; change it with subscription_change",
			"BASE_PLAN_ALREADY_ACTIVE",
			409,
		);
	}
}

/** The single currency of the plan's Stripe prices, lowercased, or null when they disagree. */
export function setupPlanCurrency(plan: StripeRecurringCheckoutPlan): string | null {
	const currencies = new Set(plan.components.map((component) => component.currency.toLowerCase()));
	if (currencies.size !== 1) return null;
	return [...currencies][0] ?? null;
}

/**
 * A 402 from Stripe's subscription create: the card was declined or needs authentication. The
 * message is ours; Stripe's code is kept so the caller can tell the two apart.
 */
export function paymentSetupCardFailure(error: unknown): { code: string; message: string } | null {
	if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
	if (error.statusCode !== 402) return null;
	const code =
		"code" in error && typeof error.code === "string" && error.code.trim() !== ""
			? error.code.trim()
			: "card_declined";
	const message =
		code === "authentication_required"
			? "The card needs authentication, so the plan was not started. The card stays saved; start the plan with checkout_plan."
			: "The card was declined, so the plan was not started. The card stays saved; start the plan with checkout_plan.";
	return { code, message };
}

/**
 * Resolves the setup's plan and starts it on the customer default card, or records why it did not.
 * The caller completes the setup afterwards. A thrown error is not an outcome: the caller retries it.
 */
export async function startPlanOnSavedCard(
	context: SavedCardPlanContext,
	setup: PaymentSetupRow,
	workerId: string,
): Promise<void> {
	const planKey = setup.plan_key;
	const planVersionId = setup.plan_version_id;
	const quantities = setup.plan_quantities;
	if (planKey === null || planVersionId === null || quantities === null) {
		throw new BillingError(
			"Payment setup is missing the plan it was reserved to start",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			409,
		);
	}

	// A previous create may have succeeded even if its response or local writes failed.
	// Recover that fact before current catalog/eligibility checks can reject the purchase.
	const existing = await findSetupSubscription(context, setup);
	if (existing !== null) {
		await finishWithSubscription(context, setup, workerId, existing);
		return;
	}

	let plan: StripeRecurringCheckoutPlan;
	try {
		plan = await context.repository.getStripeRecurringCheckoutPlanByKey(
			planKey,
			setup.billing_account_id,
		);
	} catch (error) {
		if (isBillingError(error) && PLAN_OUTCOME_CODES.has(error.code)) {
			await recordOutcome(context, setup, workerId, "not_eligible", error.code, error.message);
			return;
		}
		throw error;
	}
	if (plan.planVersionId !== planVersionId) {
		await recordOutcome(context, setup, workerId, "plan_changed", null, null);
		return;
	}

	let subscription: Record<string, unknown>;
	try {
		const currency = setupPlanCurrency(plan);
		if (currency === null || currency !== setup.currency) {
			throw new BillingError("Setup currency must match the plan currency", "INVALID_REQUEST", 400);
		}
		const hasActiveBasePlan = await context.repository.hasActiveBasePlan(setup.billing_account_id);
		assertSetupPlanEligible(plan, hasActiveBasePlan);
		const params = context.subscriptionCreateParams(plan, quantities, setup);
		subscription = await context.client.createSubscription(
			params,
			paymentSetupPlanIdempotencyKey(setup.id),
		);
	} catch (error) {
		const cardFailure = paymentSetupCardFailure(error);
		if (cardFailure !== null) {
			await recordOutcome(
				context,
				setup,
				workerId,
				"payment_failed",
				cardFailure.code,
				cardFailure.message,
			);
			return;
		}
		if (isBillingError(error) && PLAN_OUTCOME_CODES.has(error.code)) {
			await recordOutcome(context, setup, workerId, "not_eligible", error.code, error.message);
			return;
		}
		throw error;
	}
	// Once Stripe has returned a subscription, local failures must remain retryable.
	await finishWithSubscription(context, setup, workerId, subscription);
}

async function finishWithSubscription(
	context: SavedCardPlanContext,
	setup: PaymentSetupRow,
	workerId: string,
	subscription: Record<string, unknown>,
): Promise<void> {
	const externalSubscriptionId = subscriptionId(subscription);
	await context.repository.recordPaymentSetupSubscriptionId({
		setupId: setup.id,
		workerId,
		externalSubscriptionId,
	});
	const status = optionalString(subscription.status);
	if (!SUCCESSFUL_SUBSCRIPTION_STATUSES.has(status ?? "")) {
		await recordOutcome(
			context,
			setup,
			workerId,
			"payment_failed",
			"subscription_incomplete",
			"The payment did not complete, so the plan was not started. The card stays saved; start the plan with checkout_plan.",
		);
		return;
	}
	await context.recordSubscription(subscription);
	await recordOutcome(context, setup, workerId, "started", null, null, externalSubscriptionId);
}

/**
 * The subscription this setup already created, if a previous attempt died after Stripe accepted it.
 * The stored id wins; otherwise the customer's subscriptions are matched on the setup id.
 */
async function findSetupSubscription(
	context: SavedCardPlanContext,
	setup: PaymentSetupRow,
): Promise<Record<string, unknown> | null> {
	if (setup.external_subscription_id !== null) {
		return requireSubscription(
			await context.client.retrieveSubscription(setup.external_subscription_id),
		);
	}
	const listed = await context.client.listCustomerSubscriptions(setup.provider_customer_id);
	const matches = listed.filter((subscription) => setupIdOf(subscription) === setup.id);
	if (matches.length > 1) {
		throw new BillingError(
			"More than one Stripe subscription is tagged with this payment setup",
			"STRIPE_PAYMENT_SETUP_MISMATCH",
			409,
		);
	}
	return matches[0] ?? null;
}

async function recordOutcome(
	context: SavedCardPlanContext,
	setup: PaymentSetupRow,
	workerId: string,
	status: Exclude<PaymentSetupPlanStatus, "pending">,
	failureCode: string | null,
	failureMessage: string | null,
	externalSubscriptionId: string | null = setup.external_subscription_id,
): Promise<void> {
	const input: RecordPaymentSetupPlanOutcomeInput = {
		setupId: setup.id,
		workerId,
		status,
		externalSubscriptionId,
		failureCode,
		failureMessage,
	};
	await context.repository.recordPaymentSetupPlanOutcome(input);
}

function setupIdOf(subscription: Record<string, unknown>): string | null {
	const metadata = optionalRecord(subscription.metadata);
	const value = metadata?.quotumPaymentSetupId;
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function subscriptionId(subscription: Record<string, unknown>): string {
	const id = optionalString(subscription.id);
	if (id === null) {
		throw new BillingError(
			"Stripe subscription did not include an id",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			502,
		);
	}
	return id;
}

function requireSubscription(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || optionalString(value.id) === null) {
		throw new BillingError(
			"Stripe subscription could not be read",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			502,
		);
	}
	return value;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
