import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { AutoTopupChargeResult, AutoTopupJob } from "../../billing/auto-topup";
import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
	CommercialPreviewCancellation,
	CommercialPreviewDraft,
	StoredCommercialActionPreview,
} from "../../billing/commercial";
import { priceCommercialLines } from "../../billing/commercial-pricing";
import { sha256Hex, stableJson } from "../../billing/decimal";
import { BillingError } from "../../billing/errors";
import {
	normalizePaymentSetupCurrency,
	type PaymentSetupSession,
} from "../../billing/payment-setup";
import {
	type CommercialPromotion,
	normalizePromotionCode,
	type PromotionStripeSyncJob,
	type PromotionStripeSyncOutcome,
	type PromotionTarget,
	promotionError,
} from "../../billing/promotions";
import type {
	SubscriptionCancellationContext,
	SubscriptionChangeInput,
	SubscriptionChangeOperation,
	SubscriptionChangePreview,
	UsageInvoiceJob,
} from "../../billing/recurring";
import type { ProjectionContract, PurchaseKind, SubscriptionStatus } from "../../billing/types";
import type {
	CompleteStripeCheckoutRequestInput,
	GetStripeProviderCustomerInput,
	LinkStripeProviderCustomerInput,
	PrepareStripeCheckoutRequestInput,
	ProviderSubscriptionReconciliationRow,
	RecordStripeCreditPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSkippedEventInput,
	RecordStripeSubscriptionProjectionInput,
	StoreEventReplayJobRow,
	StripeBillingAccountSummary,
	StripeCheckoutRequestState,
	StripeRecordingResult,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "../../db/repository";
import { paymentSetupReconcileEventType } from "../../db/repository/store-events";
import type { AutoTopupWorkerProvider } from "../../workers/auto-topup";
import type { PromotionStripeProvider } from "../../workers/promotion-maintenance";
import type { RecurringBillingWorkerProvider } from "../../workers/recurring-billing";
import type {
	StoreEventReplayProvider,
	StoreEventReplayProviderResult,
} from "../../workers/store-event-replay";
import type { SubscriptionReconciliationProvider } from "../../workers/subscription-reconciliation";
import { commercialPreviewProvider } from "../capabilities";
import { requireNonBlank } from "../validation";
import { stripeCapabilities } from "./capabilities";
import type { StripeCheckoutSessionCreateParams } from "./client";
import {
	normalizeStripeCheckoutSession,
	normalizeStripeCheckoutSessionTermination,
	normalizeStripeDispute,
	normalizeStripeInvoice,
	normalizeStripeRefund,
	normalizeStripeSubscription,
} from "./normalizer";
import {
	applyPaymentSetupEvent,
	createPaymentSetup,
	enqueuePaymentSetupEvent,
	type NormalizedPaymentSetupEvent,
	normalizePaymentSetupEvent,
	PAYMENT_SETUP_METADATA_KEY,
	type PaymentSetupClientDependency,
	type PaymentSetupContext,
	type PaymentSetupCreation,
	type PaymentSetupRepositoryDependency,
	type PaymentSetupRequestParameters,
	paymentSetupPreviewFacts,
	reconcilePaymentSetup,
} from "./payment-setup";
import { type StripePromotionClient, syncPromotionStripeObject } from "./promotions";
import {
	assertSetupPlanEligible,
	type SavedCardPlanContext,
	setupPlanCurrency,
	startPlanOnSavedCard,
} from "./saved-card-plan";
import type {
	NormalizedStripeCheckoutPromotion,
	NormalizedStripeCommand,
	NormalizedStripeCreditPurchaseCommand,
	NormalizedStripeCreditReversalCommand,
	NormalizedStripeSubscriptionCommand,
	StripeCatalog,
} from "./types";

export interface StripeBillingServiceConfig {
	/** Non-secret connection identity stored on provider rows; never used for event matching. */
	accountIdentity?: string | null;
	connectedAccountId?: string;
	connectedAccountLivemode?: boolean;
	projectKey?: string;
	checkoutSuccessUrl: string;
	checkoutCancelUrl: string;
	portalReturnUrl: string;
	allowedReturnOrigins?: readonly string[];
	taxMode?: "disabled" | "test" | "registered";
	integrationIdentifier?: string;
	projectionContract?: ProjectionContract;
}

export interface StripeBillingClientDependency extends PaymentSetupClientDependency {
	createCustomer(input: {
		billingAccountId: string;
		email: string | null;
		idempotencyScope?: string | null;
	}): Promise<{ id: string }>;
	createCheckoutSession(
		params: StripeCheckoutSessionCreateParams,
		idempotencyKey?: string,
	): Promise<{ id: string; url: string | null }>;
	expireCheckoutSession?(sessionId: string): Promise<unknown>;
	createPortalSession(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
	retrieveCheckoutSession(sessionId: string): Promise<{
		id: string;
		status: string | null;
		payment_status: string | null;
		client_reference_id: string | null;
		metadata: Stripe.Metadata | null;
		customer_email?: string | null;
		customer_details?: { email?: string | null } | null;
	}>;
	constructWebhookEvent(rawBody: string, signature: string): unknown | Promise<unknown>;
	retrieveSubscription(subscriptionId: string): Promise<unknown>;
	createSubscription(
		params: Stripe.SubscriptionCreateParams,
		idempotencyKey: string,
	): Promise<Record<string, unknown>>;
	listCustomerSubscriptions(customerId: string): Promise<Array<Record<string, unknown>>>;
	retrieveDefaultPaymentMethod?(customerId: string): Promise<string | null>;
	updateSubscription?(
		subscriptionId: string,
		params: Stripe.SubscriptionUpdateParams,
		idempotencyKey: string,
	): Promise<{ id: string }>;
	cancelSubscription?(subscriptionId: string, idempotencyKey: string): Promise<{ id: string }>;
	retrieveSubscriptionDiscounts?(
		subscriptionId: string,
	): Promise<Array<{ id: string; couponId: string | null }>>;
	createInvoice?(
		params: Stripe.InvoiceCreateParams,
		idempotencyKey: string,
	): Promise<{ id: string }>;
	addInvoiceLines?(
		invoiceId: string,
		params: Stripe.InvoiceAddLinesParams,
		idempotencyKey: string,
	): Promise<unknown>;
	finalizeInvoice?(invoiceId: string, idempotencyKey: string): Promise<unknown>;
	payInvoice?(invoiceId: string, idempotencyKey: string): Promise<unknown>;
	voidInvoice?(invoiceId: string, idempotencyKey: string): Promise<unknown>;
	createCoupon?: StripePromotionClient["createCoupon"];
	retrieveCoupon?: StripePromotionClient["retrieveCoupon"];
	createPromotionCode?: StripePromotionClient["createPromotionCode"];
	updatePromotionCode?: StripePromotionClient["updatePromotionCode"];
	findPromotionCodes?: StripePromotionClient["findPromotionCodes"];
}

interface StripeBillingRepositoryDependency extends PaymentSetupRepositoryDependency {
	listStripeCatalog(): Promise<StripeCatalog>;

	getStripeBillingAccountSummary(billingAccountId: string): Promise<StripeBillingAccountSummary>;

	prepareStripeCheckoutRequest(
		input: PrepareStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState>;

	completeStripeCheckoutRequest(
		input: CompleteStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState>;

	getStripeWebStoreProductByKey(productKey: string): Promise<StripeWebStoreProductRow>;

	getStripeRecurringCheckoutPlanByKey?(
		planKey: string,
		billingAccountId: string,
	): Promise<StripeRecurringCheckoutPlan>;

	hasActiveBasePlan?(billingAccountId: string): Promise<boolean>;

	prepareSubscriptionChange?(input: SubscriptionChangeInput): Promise<SubscriptionChangeOperation>;
	previewSubscriptionChange?(
		input: Omit<SubscriptionChangeInput, "idempotencyKey" | "expectedStateFingerprint">,
	): Promise<SubscriptionChangePreview>;
	previewSubscriptionCancellation?(input: {
		billingAccountId: string;
		externalSubscriptionId: string;
	}): Promise<SubscriptionCancellationContext>;
	createCommercialActionPreview?(draft: CommercialPreviewDraft): Promise<CommercialActionPreview>;
	resolveCommercialPromotion?(input: {
		billingAccountId: string;
		code: string;
		target: PromotionTarget;
	}): Promise<CommercialPromotion>;
	prepareStripeCoupon?(
		promotionId: string,
	): Promise<{ objectId: string; status: string; externalId: string | null; error: string | null }>;
	claimStripePromotionObject?(
		objectId: string,
		workerId: string,
	): Promise<PromotionStripeSyncJob | null>;
	markStripePromotionObjectOutcome?(
		objectId: string,
		workerId: string,
		outcome:
			| { kind: "ready"; externalId: string; providerActive: boolean }
			| { kind: "retired"; externalId: string | null }
			| { kind: "failed"; error: string; nextAttemptAt: Date | null },
	): Promise<void>;
	recordStripeCheckoutPromotion?(input: {
		billingAccountId: string;
		promotion: NormalizedStripeCheckoutPromotion;
	}): Promise<void>;
	releaseStripeCheckoutPromotion?(input: {
		checkoutSessionId: string;
		redemptionId: string | null;
	}): Promise<void>;
	ensureSubscriptionDiscountAvailable?(externalSubscriptionId: string): Promise<void>;
	reserveCommercialPromotion?(input: {
		billingAccountId: string;
		promotionCodeId: string;
		idempotencyKey: string;
		requestHash: string;
		reservedUntil: Date;
		effectSnapshot: Record<string, unknown>;
		stripeCouponId: string;
	}): Promise<{ id: string; status: "reserved" | "applied" | "released" | "reversed" }>;
	attachPromotionCheckoutSession?(input: {
		redemptionId: string;
		checkoutSessionId: string;
		reservedUntil: Date;
	}): Promise<void>;
	getCommercialActionPreview?(
		billingAccountId: string,
		previewToken: string,
	): Promise<StoredCommercialActionPreview>;
	beginCommercialActionExecution?(input: {
		billingAccountId: string;
		previewToken: string;
		intentHash: string;
		stateFingerprint: string;
		idempotencyKey: string;
	}): Promise<StoredCommercialActionPreview>;
	completeCommercialActionExecution?(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
		result: CommercialActionExecutionResult;
	}): Promise<CommercialActionExecutionResult>;
	completeSubscriptionCancellation?(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
		externalSubscriptionId: string;
		supersedeReason: string;
		supersedesPendingChange: boolean;
		result: Omit<SubscriptionCancellationResult, "supersededChangeId">;
	}): Promise<CommercialActionExecutionResult>;

	getStripeProviderCustomer(input: GetStripeProviderCustomerInput): Promise<string | null>;

	linkStripeProviderCustomer(input: LinkStripeProviderCustomerInput): Promise<string>;

	recordStripeCreditPurchaseAndEnqueueProjection(
		input: RecordStripeCreditPurchaseProjectionInput,
	): Promise<StripeRecordingResult>;

	recordStripeSubscriptionAndEnqueueProjection(
		input: RecordStripeSubscriptionProjectionInput,
	): Promise<StripeRecordingResult>;

	recordStripeCreditReversalAndEnqueueProjection(
		input: RecordStripeCreditReversalProjectionInput,
	): Promise<StripeRecordingResult>;

	recordStripeSkippedEvent(input: RecordStripeSkippedEventInput): Promise<StripeRecordingResult>;
}

export interface StripeBillingServiceDependencies {
	config: StripeBillingServiceConfig;
	client: StripeBillingClientDependency;
	repository: StripeBillingRepositoryDependency;
}

export interface CreateStripeCheckoutSessionInput {
	billingAccountId: string;
	productKey?: string;
	planKey?: string;
	quantities?: Record<string, number>;
	email?: string | null;
	idempotencyKey?: string | null;
	successUrl?: string | null;
	cancelUrl?: string | null;
	expectedTargetId?: string;
	expiresAt?: number;
	/** Stripe coupon id Quotum already validated and reserved for this request. */
	discountCoupon?: string;
	promotionRedemptionId?: string;
	allowPromotionCodes?: boolean;
}

export interface StripeCheckoutSessionResult {
	readonly sessionId: string;
	readonly url: string;
	readonly duplicate: boolean;
}

export interface StripePortalSessionResult {
	readonly url: string;
}

export interface StripeCheckoutSessionStatus {
	readonly sessionId: string;
	readonly status: "open" | "complete" | "expired" | "unknown";
	readonly paymentStatus: "paid" | "unpaid" | "no_payment_required" | "unknown" | null;
	readonly customerEmail: string | null;
	readonly productKey: string | null;
}

export interface StripeWebhookResult {
	readonly status: "processed" | "skipped" | "ignored";
	readonly eventType: string;
	readonly entitlements: unknown | null;
}

type StripeCheckoutMode = "payment" | "subscription";

type SubscriptionCancellationResult = Extract<
	CommercialActionExecutionResult,
	{ kind: "subscription_cancellation" }
>;

type CancellationIntent = Extract<CommercialActionIntent, { kind: "cancel" | "uncancel" }>;

interface ParsedStripeEvent {
	id: string;
	type: string;
	created: number;
	object: Record<string, unknown>;
}

export class StripeBillingService
	implements
		StoreEventReplayProvider,
		SubscriptionReconciliationProvider,
		RecurringBillingWorkerProvider,
		AutoTopupWorkerProvider,
		PromotionStripeProvider
{
	constructor(private readonly dependencies: StripeBillingServiceDependencies) {}

	async getCatalog(): Promise<StripeCatalog> {
		return await this.dependencies.repository.listStripeCatalog();
	}

	async getBillingAccount(billingAccountId: string): Promise<StripeBillingAccountSummary> {
		return await this.dependencies.repository.getStripeBillingAccountSummary(
			requireNonBlank(billingAccountId, "billingAccountId"),
		);
	}

	async createCheckoutSession(
		input: CreateStripeCheckoutSessionInput,
	): Promise<StripeCheckoutSessionResult> {
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const productKey = optionalNonBlankString(input.productKey);
		const planKey = optionalNonBlankString(input.planKey);
		if ((productKey === null) === (planKey === null)) {
			throw new BillingError(
				"Exactly one of productKey or planKey is required",
				"INVALID_REQUEST",
				400,
			);
		}
		const product =
			productKey === null
				? null
				: await this.dependencies.repository.getStripeWebStoreProductByKey(productKey);
		const plan =
			planKey === null
				? null
				: await requireRecurringPlanRepository(this.dependencies.repository)(
						planKey,
						billingAccountId,
					);
		if (product === null && plan === null) {
			throw new BillingError("A Checkout target is required", "INVALID_REQUEST", 400);
		}
		const resolvedTargetId = product?.storeProductId ?? plan?.planVersionId;
		if (input.expectedTargetId !== undefined && input.expectedTargetId !== resolvedTargetId) {
			throw new BillingError(
				"Catalog state changed after preview",
				"COMMERCIAL_PREVIEW_STALE",
				409,
			);
		}
		const targetKey = productKey ?? planKey;
		if (targetKey === null) {
			throw new BillingError("A Checkout target is required", "INVALID_REQUEST", 400);
		}
		if (
			plan?.kind === "addon" &&
			!(await requireActiveBasePlanRepository(this.dependencies.repository)(billingAccountId))
		) {
			throw new BillingError(
				"An active base plan is required before purchasing an add-on",
				"ADDON_REQUIRES_BASE_PLAN",
				409,
			);
		}
		const quantities = normalizedLicensedQuantities(input.quantities ?? {});
		const mode: StripeCheckoutMode = product === null ? "subscription" : checkoutModeFor(product);
		const email = input.email ?? null;
		if (
			input.expiresAt !== undefined &&
			(!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0)
		) {
			throw new BillingError("Invalid Checkout expiration", "INVALID_REQUEST", 400);
		}
		const idempotencyKey = parseOptionalIdempotencyKey(input.idempotencyKey);
		const successUrl = this.returnUrl(
			input.successUrl,
			this.dependencies.config.checkoutSuccessUrl,
			{
				requireCheckoutPlaceholder: true,
			},
		);
		const cancelUrl = this.returnUrl(input.cancelUrl, this.dependencies.config.checkoutCancelUrl);
		const stripeCustomerId = await this.getOrCreateCustomer(billingAccountId, email);
		const requestHash = checkoutRequestHash({
			billingAccountId,
			targetKey,
			targetKind: product === null ? "plan" : "product",
			quantities,
			email,
			successUrl,
			cancelUrl,
			...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			...(input.discountCoupon === undefined ? {} : { discountCoupon: input.discountCoupon }),
			...(input.promotionRedemptionId === undefined
				? {}
				: { promotionRedemptionId: input.promotionRedemptionId }),
			...(input.allowPromotionCodes === true ? { allowPromotionCodes: true } : {}),
			// Last, and only when set, so every request whose trial still applies keeps its hash.
			...(plan !== null && planTrialSkipped(plan) ? { trialSkipped: true } : {}),
		});
		if (idempotencyKey !== null) {
			const receipt = await this.dependencies.repository.prepareStripeCheckoutRequest({
				billingAccountId,
				storeProductId: product?.storeProductId ?? null,
				planVersionId: plan?.planVersionId ?? null,
				requestedQuantities: quantities,
				idempotencyKey,
				requestHash,
				...this.providerAccount(),
			});
			if (
				receipt.status === "created" &&
				receipt.externalSessionId !== null &&
				receipt.sessionUrl !== null
			) {
				return checkoutSessionResult(receipt.externalSessionId, receipt.sessionUrl, true);
			}
		}
		let metadata: Record<string, string>;
		let lineItems: Array<{ price: string; quantity: number }>;
		if (product === null) {
			if (plan === null) {
				throw new BillingError("A Checkout target is required", "INVALID_REQUEST", 400);
			}
			metadata = recurringCheckoutMetadata(billingAccountId, plan);
			lineItems = recurringCheckoutLines(plan, quantities);
		} else {
			metadata = checkoutMetadata(billingAccountId, product);
			lineItems = [{ price: product.externalPriceId, quantity: 1 }];
		}
		if (input.discountCoupon !== undefined && input.allowPromotionCodes === true) {
			throw promotionError("PROMOTION_CODE_ENTRY_CONFLICT");
		}
		if (input.promotionRedemptionId !== undefined) {
			metadata = { ...metadata, quotumPromotionRedemptionId: input.promotionRedemptionId };
		}
		const params: Stripe.Checkout.SessionCreateParams = {
			customer: stripeCustomerId,
			...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
			mode,
			line_items: lineItems,
			success_url: successUrl,
			cancel_url: cancelUrl,
			client_reference_id: billingAccountId,
			metadata,
			integration_identifier: this.dependencies.config.integrationIdentifier ?? "qfmxzjpa",
			...(input.discountCoupon === undefined
				? {}
				: { discounts: [{ coupon: input.discountCoupon }] }),
			...(input.allowPromotionCodes === true ? { allow_promotion_codes: true } : {}),
		};
		if ((this.dependencies.config.taxMode ?? "disabled") !== "disabled") {
			params.automatic_tax = { enabled: true };
			params.tax_id_collection = { enabled: true };
			params.customer_update = { address: "auto" };
		}

		if (mode === "payment") {
			params.payment_intent_data = { metadata };
		} else {
			params.subscription_data = { metadata };
			if (plan !== null && planTrialApplies(plan) && plan.trialDays !== null) {
				params.subscription_data.trial_period_days = plan.trialDays;
				params.subscription_data.trial_settings = {
					end_behavior: { missing_payment_method: plan.trialEndBehavior },
				};
				if (!plan.trialRequiresPaymentMethod) {
					params.payment_method_collection = "if_required";
				}
			}
		}

		const session = await this.dependencies.client.createCheckoutSession(
			params,
			idempotencyKey === null
				? undefined
				: stripeCheckoutIdempotencyKey(
						this.dependencies.config.projectKey ?? "project",
						idempotencyKey,
					),
		);
		if (typeof session.url !== "string" || session.url.trim() === "") {
			throw new BillingError(
				"Stripe Checkout session did not include a redirect URL",
				"STRIPE_CHECKOUT_URL_MISSING",
				502,
			);
		}

		if (idempotencyKey !== null) {
			await this.dependencies.repository.completeStripeCheckoutRequest({
				billingAccountId,
				idempotencyKey,
				requestHash,
				externalSessionId: session.id,
				sessionUrl: session.url,
			});
		}

		return checkoutSessionResult(session.id, session.url, false);
	}

	async createRecurringCheckoutSession(input: {
		billingAccountId: string;
		planKey: string;
		quantities?: Record<string, number>;
		email?: string | null;
		idempotencyKey?: string | null;
		successUrl?: string | null;
		cancelUrl?: string | null;
	}): Promise<StripeCheckoutSessionResult> {
		return await this.createCheckoutSession(input);
	}

	async requestSubscriptionChange(
		input: SubscriptionChangeInput,
	): Promise<SubscriptionChangeOperation> {
		if (this.dependencies.repository.prepareSubscriptionChange === undefined) {
			throw new BillingError(
				"Subscription changes are not configured",
				"STRIPE_NOT_CONFIGURED",
				503,
			);
		}
		return await this.dependencies.repository.prepareSubscriptionChange(input);
	}

	/** Creates or updates the Stripe coupon or promotion code behind one Quotum promotion object. */
	async syncPromotionStripeObject(
		job: PromotionStripeSyncJob,
	): Promise<PromotionStripeSyncOutcome> {
		const client = this.dependencies.client;
		if (
			client.createCoupon === undefined ||
			client.retrieveCoupon === undefined ||
			client.createPromotionCode === undefined ||
			client.updatePromotionCode === undefined ||
			client.findPromotionCodes === undefined
		) {
			return { kind: "failed", error: "Stripe promotions are unavailable", terminal: true };
		}
		return await syncPromotionStripeObject(
			{
				createCoupon: client.createCoupon.bind(client),
				retrieveCoupon: client.retrieveCoupon.bind(client),
				createPromotionCode: client.createPromotionCode.bind(client),
				updatePromotionCode: client.updatePromotionCode.bind(client),
				findPromotionCodes: client.findPromotionCodes.bind(client),
			},
			job,
		);
	}

	/**
	 * Returns the Stripe coupon for a promotion, creating it now when the worker has not yet. A
	 * coupon another process is creating, or one Stripe rejected, is reported as not ready.
	 */
	private async ensureStripeCoupon(promotionId: string): Promise<string> {
		const repository = this.dependencies.repository;
		if (
			repository.prepareStripeCoupon === undefined ||
			repository.claimStripePromotionObject === undefined ||
			repository.markStripePromotionObjectOutcome === undefined
		) {
			throw promotionError("PROMOTION_PROVIDER_NOT_READY");
		}
		const prepared = await repository.prepareStripeCoupon(promotionId);
		if (prepared.status === "ready" && prepared.externalId !== null) return prepared.externalId;
		if (prepared.status === "failed") {
			throw promotionError(
				"PROMOTION_PROVIDER_NOT_READY",
				`The Stripe coupon for this promotion failed: ${prepared.error ?? "unknown error"}`,
			);
		}
		const workerId = `commercial:${crypto.randomUUID()}`;
		const job = await repository.claimStripePromotionObject(prepared.objectId, workerId);
		if (job === null) throw promotionError("PROMOTION_PROVIDER_NOT_READY");
		const outcome = await this.syncPromotionStripeObject(job);
		if (outcome.kind === "ready") {
			await repository.markStripePromotionObjectOutcome(prepared.objectId, workerId, outcome);
			return outcome.externalId;
		}
		await repository.markStripePromotionObjectOutcome(prepared.objectId, workerId, {
			kind: "failed",
			error: outcome.kind === "failed" ? outcome.error : "Stripe coupon was retired",
			nextAttemptAt: outcome.kind === "failed" && outcome.terminal ? null : new Date(),
		});
		throw promotionError("PROMOTION_PROVIDER_NOT_READY");
	}

	private async reserveCheckoutPromotion(input: {
		billingAccountId: string;
		promotion: CommercialPromotion;
		idempotencyKey: string;
		requestHash: string;
		stripeCouponId: string;
	}): Promise<{ id: string; status: "reserved" | "applied" }> {
		const repository = this.dependencies.repository;
		if (repository.reserveCommercialPromotion === undefined) {
			throw promotionError("PROMOTION_PROVIDER_NOT_READY");
		}
		const redemption = await repository.reserveCommercialPromotion({
			billingAccountId: input.billingAccountId,
			promotionCodeId: input.promotion.promotionCodeId,
			idempotencyKey: input.idempotencyKey,
			requestHash: input.requestHash,
			reservedUntil: new Date(Date.now() + 30 * 60_000),
			effectSnapshot: {
				kind: "discount",
				promotionKey: input.promotion.promotionKey,
				discount: input.promotion.discount,
			},
			stripeCouponId: input.stripeCouponId,
		});
		if (redemption.status !== "reserved" && redemption.status !== "applied") {
			throw promotionError("PROMOTION_CODE_EXHAUSTED");
		}
		return { id: redemption.id, status: redemption.status };
	}

	async previewCommercialAction(input: {
		billingAccountId: string;
		intent: CommercialActionIntent;
	}): Promise<CommercialActionPreview> {
		const repository = requireCommercialRepository(this.dependencies.repository);
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const draft = await this.commercialPreviewDraft(billingAccountId, input.intent);
		return await repository.createCommercialActionPreview(draft);
	}

	async executeCommercialAction(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
	}): Promise<CommercialActionExecutionResult> {
		const repository = requireCommercialRepository(this.dependencies.repository);
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const idempotencyKey = requireNonBlank(input.idempotencyKey, "idempotencyKey");
		const previewToken = requireNonBlank(input.previewToken, "previewToken");
		const stored = await repository.getCommercialActionPreview(billingAccountId, previewToken);
		if (stored.status === "executed" && stored.executionResult !== null) {
			if (stored.executionIdempotencyKey !== idempotencyKey) {
				throw new BillingError(
					"Commercial action execution is already bound to another idempotency key",
					"IDEMPOTENCY_CONFLICT",
					409,
				);
			}
			return stored.executionResult;
		}
		const current = await this.commercialPreviewDraft(billingAccountId, stored.intent, false);
		const claimed = await repository.beginCommercialActionExecution({
			billingAccountId,
			previewToken,
			intentHash: current.intentHash,
			stateFingerprint: current.stateFingerprint,
			idempotencyKey,
		});
		if (claimed.status === "executed" && claimed.executionResult !== null) {
			return claimed.executionResult;
		}

		if (current.intent.kind === "setup_payment") {
			const creation = await this.executePaymentSetup({
				billingAccountId,
				previewToken,
				idempotencyKey,
				intent: current.intent,
			});
			return await repository.completeCommercialActionExecution({
				billingAccountId,
				previewToken,
				idempotencyKey,
				result: { kind: "payment_setup", ...creation },
			});
		}

		if (current.intent.kind === "cancel" || current.intent.kind === "uncancel") {
			const cancellation = current.preview.cancellation;
			if (cancellation === null) throw new Error("Cancellation preview is missing its effects");
			// The completion owns the supersede transaction, so it records the execution itself.
			return await this.executeSubscriptionCancellation({
				billingAccountId,
				previewToken,
				idempotencyKey,
				intent: current.intent,
				cancellation,
			});
		}
		let result: CommercialActionExecutionResult;
		if (current.intent.kind === "subscription_change") {
			const executionKey = commercialExecutionKey(previewToken, idempotencyKey);
			const promotion = current.promotion ?? null;
			const operation = await this.requestSubscriptionChange({
				billingAccountId,
				externalSubscriptionId: current.intent.externalSubscriptionId,
				targetPlanKey: current.intent.targetPlanKey,
				quantities: current.intent.quantities,
				effectiveMode: current.intent.effectiveMode,
				prorationBehavior: current.intent.prorationBehavior,
				idempotencyKey: executionKey,
				expectedStateFingerprint: current.providerStateFingerprint ?? current.stateFingerprint,
				...(promotion === null
					? {}
					: {
							promotion: {
								promotionCodeId: promotion.promotionCodeId,
								idempotencyKey: `promotion:${executionKey}`,
								effectSnapshot: {
									kind: "discount",
									promotionKey: promotion.promotionKey,
									discount: promotion.discount,
								},
								stripeCouponId: await this.ensureStripeCoupon(promotion.promotionId),
							},
						}),
			});
			result = {
				kind: "subscription_change",
				changeId: operation.changeId,
				status: operation.status,
				effectiveMode: operation.effectiveMode,
				effectiveAt: operation.effectiveAt,
				promotionRedemption: operation.promotionRedemption,
			};
		} else {
			const executionKey = commercialExecutionKey(previewToken, idempotencyKey);
			const promotion = current.promotion ?? null;
			let redemption: { id: string; status: "reserved" | "applied" } | null = null;
			let discountCoupon: string | undefined;
			if (promotion !== null) {
				discountCoupon = await this.ensureStripeCoupon(promotion.promotionId);
				redemption = await this.reserveCheckoutPromotion({
					billingAccountId,
					promotion,
					idempotencyKey: `promotion:${executionKey}`,
					requestHash: current.intentHash,
					stripeCouponId: discountCoupon,
				});
			}
			const session = await this.createCheckoutSession({
				billingAccountId,
				...(current.intent.kind === "checkout_plan"
					? { planKey: current.intent.planKey, quantities: current.intent.quantities }
					: { productKey: current.intent.productKey }),
				email: current.intent.email,
				successUrl: current.intent.successUrl,
				cancelUrl: current.intent.cancelUrl,
				...(current.intent.expiresAt === undefined ? {} : { expiresAt: current.intent.expiresAt }),
				...(discountCoupon === undefined || redemption === null
					? {}
					: { discountCoupon, promotionRedemptionId: redemption.id }),
				...(current.intent.allowPromotionCodes === true ? { allowPromotionCodes: true } : {}),
				idempotencyKey: executionKey,
				expectedTargetId: current.preview.targetId,
			});
			if (redemption?.status === "reserved") {
				await this.dependencies.repository.attachPromotionCheckoutSession?.({
					redemptionId: redemption.id,
					checkoutSessionId: session.sessionId,
					reservedUntil: checkoutReservationDeadline(current.intent.expiresAt),
				});
			}
			result = { kind: "checkout", ...session, promotionRedemption: redemption };
		}
		return await repository.completeCommercialActionExecution({
			billingAccountId,
			previewToken,
			idempotencyKey,
			result,
		});
	}

	private async commercialPreviewDraft(
		billingAccountId: string,
		intent: CommercialActionIntent,
		checkSetupConflict = true,
	): Promise<CommercialPreviewDraft> {
		const normalized = normalizeCommercialIntent(intent);
		const intentHash = sha256Hex(stableJson(normalized));
		if (normalized.kind === "cancel" || normalized.kind === "uncancel") {
			return await this.cancellationPreviewDraft(billingAccountId, normalized, intentHash);
		}
		if (normalized.kind === "setup_payment") {
			return this.paymentSetupPreviewDraft(
				billingAccountId,
				normalized,
				intentHash,
				checkSetupConflict,
			);
		}
		if (normalized.kind === "subscription_change") {
			const repository = this.dependencies.repository;
			if (repository.previewSubscriptionChange === undefined) {
				throw new BillingError(
					"Commercial previews are not configured",
					"STRIPE_NOT_CONFIGURED",
					503,
				);
			}
			const change = await repository.previewSubscriptionChange({
				billingAccountId,
				externalSubscriptionId: normalized.externalSubscriptionId,
				targetPlanKey: normalized.targetPlanKey,
				quantities: normalized.quantities,
				effectiveMode: normalized.effectiveMode,
				prorationBehavior: normalized.prorationBehavior,
			});
			const promotion = await this.commercialPromotion(billingAccountId, normalized.promotionCode, {
				kind: "plan",
				key: normalized.targetPlanKey,
			});
			if (promotion !== null) {
				if (repository.ensureSubscriptionDiscountAvailable === undefined) {
					throw promotionError("PROMOTION_PROVIDER_NOT_READY");
				}
				await repository.ensureSubscriptionDiscountAvailable(normalized.externalSubscriptionId);
			}
			const currency = oneCurrency(change.lineItems);
			const interval = change.lineItems[0]?.interval ?? "month";
			const renewal = priceCommercialLines({
				lines: change.lineItems,
				currency,
				recurringInterval: interval,
				promotion,
				hostedEntry: false,
			});
			const stateFingerprint = promotionFingerprint(change.stateFingerprint, promotion);
			return {
				billingAccountId,
				intent: normalized,
				intentHash,
				stateFingerprint,
				providerStateFingerprint: change.stateFingerprint,
				promotion,
				preview: {
					schemaVersion: 1,
					intentHash,
					stateFingerprint,
					billingAccountId,
					action: normalized.kind,
					provider: commercialPreviewProvider(stripeCapabilities, normalized),
					lineItems: change.lineItems.map((line) => ({
						...line,
						subtotalMinor: null,
						discountMinor: null,
						totalMinor: null,
					})),
					estimatedTotalMinor: null,
					subtotalMinor: null,
					discountTotalMinor: null,
					currency,
					amountStatus: "provider_calculated",
					promotionCodeEntry: renewal.promotionCodeEntry,
					promotion: renewal.promotion,
					nextCycle:
						promotion !== null && promotion.discount.duration === "once"
							? {
									interval,
									currency,
									subtotalMinor: null,
									discountMinor: null,
									totalMinor: null,
									discountStatus: "provider_calculated",
								}
							: renewal.nextCycle,
					cancellation: null,
					paymentSetup: null,
					effectiveMode: change.effectiveMode,
					effectiveAt: change.effectiveAt,
					prorationBehavior: change.prorationBehavior,
					changeKind: change.changeKind,
					fromPlanVersionId: change.fromPlanVersionId,
					toPlanVersionId: change.toPlanVersionId,
					targetId: change.toPlanVersionId,
					warnings: ["Stripe calculates the final proration amount during execution."],
				},
			};
		}

		const hostedEntry = normalized.allowPromotionCodes === true;
		if (normalized.kind === "checkout_product") {
			const product = await this.dependencies.repository.getStripeWebStoreProductByKey(
				normalized.productKey,
			);
			const promotion = await this.commercialPromotion(billingAccountId, normalized.promotionCode, {
				kind: "product",
				key: product.productKey,
			});
			const stateFingerprint = promotionFingerprint(sha256Hex(stableJson(product)), promotion);
			const priced = priceCommercialLines({
				lines: [
					{
						key: product.productKey,
						label: product.productName ?? product.productKey,
						quantity: 1,
						unitAmountMinor: product.priceAmount ?? 0,
						currency: product.currency ?? "",
						interval: null,
						pricingModel: "flat",
					},
				],
				currency: product.currency,
				recurringInterval: recurringIntervalOf(product.billingPeriod),
				promotion,
				hostedEntry,
			});
			return {
				billingAccountId,
				intent: normalized,
				intentHash,
				stateFingerprint,
				promotion,
				preview: {
					schemaVersion: 1,
					intentHash,
					stateFingerprint,
					billingAccountId,
					action: normalized.kind,
					provider: commercialPreviewProvider(stripeCapabilities, normalized),
					...priced,
					currency: product.currency,
					cancellation: null,
					paymentSetup: null,
					effectiveMode: null,
					effectiveAt: null,
					prorationBehavior: null,
					changeKind: null,
					fromPlanVersionId: null,
					toPlanVersionId: null,
					targetId: product.storeProductId,
				},
			};
		}

		const plan = await requireRecurringPlanRepository(this.dependencies.repository)(
			normalized.planKey,
			billingAccountId,
		);
		const hasActiveBasePlan = await requireActiveBasePlanRepository(this.dependencies.repository)(
			billingAccountId,
		);
		if (plan.kind === "addon" && !hasActiveBasePlan) {
			throw new BillingError(
				"An active base plan is required before purchasing an add-on",
				"ADDON_REQUIRES_BASE_PLAN",
				409,
			);
		}
		const quantities = normalizedLicensedQuantities(normalized.quantities);
		const lines = commercialPlanLines(plan, quantities);
		const promotion = await this.commercialPromotion(billingAccountId, normalized.promotionCode, {
			kind: "plan",
			key: plan.planKey,
		});
		// Trial use joins the fingerprint only when it removes the trial, so other previews keep theirs
		// and a trial started between preview and execution makes the preview stale.
		const { trialUsed: _trialUsed, ...planFacts } = plan;
		const stateFingerprint = promotionFingerprint(
			sha256Hex(
				stableJson({
					plan: planFacts,
					hasActiveBasePlan,
					...(planTrialSkipped(plan) ? { trialSkipped: true } : {}),
				}),
			),
			promotion,
		);
		const currency = oneCurrency(lines);
		const priced = priceCommercialLines({
			lines,
			currency,
			recurringInterval: lines.find((line) => line.interval !== null)?.interval ?? null,
			promotion,
			hostedEntry,
		});
		if (promotion !== null && planTrialApplies(plan)) {
			priced.warnings.push(
				"The plan starts with a trial; Stripe applies the discount to invoices from the trial onward.",
			);
		}
		if (planTrialSkipped(plan)) {
			priced.warnings.push(
				"This account already had a trial of the plan; the subscription starts without one.",
			);
		}
		const intentWithQuantities = { ...normalized, quantities };
		return {
			billingAccountId,
			intent: intentWithQuantities,
			intentHash: sha256Hex(stableJson(intentWithQuantities)),
			stateFingerprint,
			promotion,
			preview: {
				schemaVersion: 1,
				intentHash: sha256Hex(stableJson(intentWithQuantities)),
				stateFingerprint,
				billingAccountId,
				action: normalized.kind,
				provider: commercialPreviewProvider(stripeCapabilities, normalized),
				...priced,
				currency,
				cancellation: null,
				paymentSetup: null,
				effectiveMode: "immediate",
				effectiveAt: new Date().toISOString(),
				prorationBehavior: null,
				changeKind: null,
				fromPlanVersionId: null,
				toPlanVersionId: plan.planVersionId,
				targetId: plan.planVersionId,
			},
		};
	}

	/**
	 * Builds the preview for a hosted payment-method setup. Without a plan there is no catalog state
	 * to drift. With a plan, the fingerprint binds the plan version, whether a base plan is already
	 * active, and a trial this account already used, so a change between preview and execute is
	 * `COMMERCIAL_PREVIEW_STALE`.
	 */
	private async paymentSetupPreviewDraft(
		billingAccountId: string,
		intent: Extract<CommercialActionIntent, { kind: "setup_payment" }>,
		intentHash: string,
		checkConflict: boolean,
	): Promise<CommercialPreviewDraft> {
		const resolved = await this.resolveSetupPlan(billingAccountId, intent);
		const parameters = this.paymentSetupParameters(
			billingAccountId,
			intent,
			resolved.plan,
			resolved.quantities,
		);
		const facts = await paymentSetupPreviewFacts(
			this.paymentSetupContext(),
			parameters,
			checkConflict,
		);
		const planFingerprint =
			resolved.plan === null
				? null
				: {
						planKey: resolved.plan.planKey,
						planVersionId: resolved.plan.planVersionId,
						quantities: resolved.quantities,
					};
		const stateFingerprint = sha256Hex(
			stableJson({
				kind: intent.kind,
				billingAccountId,
				currency: intent.currency,
				plan: planFingerprint,
				hasActiveBasePlan: resolved.hasActiveBasePlan,
				...(resolved.plan !== null && planTrialSkipped(resolved.plan)
					? { trialSkipped: true }
					: {}),
			}),
		);
		const lines =
			resolved.plan === null ? [] : commercialPlanLines(resolved.plan, resolved.quantities);
		const priced =
			resolved.plan === null
				? null
				: priceCommercialLines({
						lines,
						currency: oneCurrency(lines)?.toLowerCase() ?? intent.currency,
						recurringInterval: lines.find((line) => line.interval !== null)?.interval ?? null,
						promotion: null,
						hostedEntry: false,
					});
		const active = facts.setup;
		const trialDays =
			resolved.plan !== null && planTrialApplies(resolved.plan) ? resolved.plan.trialDays : null;
		return {
			billingAccountId,
			intent,
			intentHash,
			stateFingerprint,
			providerStateFingerprint: stateFingerprint,
			promotion: null,
			preview: {
				schemaVersion: 1,
				intentHash,
				stateFingerprint,
				billingAccountId,
				action: intent.kind,
				provider: commercialPreviewProvider(stripeCapabilities, intent),
				lineItems: priced?.lineItems ?? [],
				estimatedTotalMinor: priced === null ? 0 : priced.estimatedTotalMinor,
				subtotalMinor: priced === null ? 0 : priced.subtotalMinor,
				discountTotalMinor: priced === null ? 0 : priced.discountTotalMinor,
				currency: intent.currency,
				amountStatus: priced?.amountStatus ?? "exact",
				promotionCodeEntry: "none",
				promotion: null,
				nextCycle: priced?.nextCycle ?? null,
				cancellation: null,
				paymentSetup: {
					currency: intent.currency,
					appliesTo: "account_default",
					preservesSubscriptionPaymentMethods: true,
					reusesExistingSetup: facts.reusesExistingSetup,
					existingSetupId: active === null ? null : active.id,
					existingSetupExpiresAt:
						active === null ? null : new Date(active.expires_at).toISOString(),
					plan:
						resolved.plan === null
							? null
							: {
									planKey: resolved.plan.planKey,
									planVersionId: resolved.plan.planVersionId,
									trialDays,
									startsAfterSetup: true,
								},
				},
				effectiveMode: "immediate",
				effectiveAt: new Date().toISOString(),
				prorationBehavior: null,
				changeKind: null,
				fromPlanVersionId: null,
				toPlanVersionId: resolved.plan?.planVersionId ?? null,
				targetId: `payment_setup:${billingAccountId}`,
				warnings: [
					...(priced?.warnings ?? []),
					...paymentSetupWarnings(facts.reusesExistingSetup),
					...(resolved.plan === null
						? []
						: [
								...(trialDays !== null
									? [
											`The plan starts a ${trialDays}-day trial after setup; the saved card is charged when the trial ends.`,
										]
									: planTrialSkipped(resolved.plan)
										? [
												"This account already had a trial of the plan; the subscription starts without one.",
											]
										: []),
								...(trialDays === null
									? [
											"The saved card is charged for this plan when setup completes. A declined payment does not start the plan.",
										]
									: []),
							]),
				],
			},
		};
	}

	/**
	 * Creates, resumes or reuses the hosted setup link. Everything the provider call needs is frozen
	 * on the setup record first, and the call itself runs outside every transaction.
	 */
	private async executePaymentSetup(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
		intent: Extract<CommercialActionIntent, { kind: "setup_payment" }>;
	}): Promise<PaymentSetupCreation> {
		const executionKey = commercialExecutionKey(input.previewToken, input.idempotencyKey);
		const resolved = await this.resolveSetupPlan(input.billingAccountId, input.intent);
		const parameters = this.paymentSetupParameters(
			input.billingAccountId,
			input.intent,
			resolved.plan,
			resolved.quantities,
		);
		const providerCustomerId = await this.getOrCreateCustomer(
			input.billingAccountId,
			input.intent.email ?? null,
		);
		return await createPaymentSetup(this.paymentSetupContext(), {
			previewToken: input.previewToken,
			providerCustomerId,
			providerIdempotencyKey: stripePaymentSetupIdempotencyKey(
				this.dependencies.config.projectKey ?? "project",
				executionKey,
			),
			parameters,
		});
	}

	/** The persisted setup, read back without a provider call. */
	async getPaymentSetupSession(input: {
		billingAccountId: string;
		sessionId: string;
	}): Promise<PaymentSetupSession> {
		const read = this.dependencies.repository.getPaymentSetupSession;
		if (read === undefined) {
			throw new BillingError(
				"Payment method setup is not configured",
				"STRIPE_NOT_CONFIGURED",
				503,
			);
		}
		return await read.call(
			this.dependencies.repository,
			requireNonBlank(input.billingAccountId, "billingAccountId"),
			requireNonBlank(input.sessionId, "sessionId"),
		);
	}

	/**
	 * Loads the plan a setup will start, and refuses a currency mismatch or a plan this charge
	 * cannot start. A setup without a plan resolves nothing.
	 */
	private async resolveSetupPlan(
		billingAccountId: string,
		intent: Extract<CommercialActionIntent, { kind: "setup_payment" }>,
	): Promise<{
		plan: StripeRecurringCheckoutPlan | null;
		quantities: Record<string, number>;
		hasActiveBasePlan: boolean | null;
	}> {
		if (intent.plan === undefined) {
			return { plan: null, quantities: {}, hasActiveBasePlan: null };
		}
		const plan = await requireRecurringPlanRepository(this.dependencies.repository)(
			intent.plan.planKey,
			billingAccountId,
		);
		const currency = setupPlanCurrency(plan);
		if (currency === null || currency !== intent.currency) {
			throw new BillingError(
				"Setup currency must match the plan currency",
				"INVALID_REQUEST",
				400,
				{ details: { currency: intent.currency, planCurrency: currency } },
			);
		}
		const quantities = normalizedLicensedQuantities(intent.plan.quantities);
		recurringCheckoutLines(plan, quantities);
		const hasActiveBasePlan = await requireActiveBasePlanRepository(this.dependencies.repository)(
			billingAccountId,
		);
		assertSetupPlanEligible(plan, hasActiveBasePlan);
		return { plan, quantities, hasActiveBasePlan };
	}

	private paymentSetupParameters(
		billingAccountId: string,
		intent: Extract<CommercialActionIntent, { kind: "setup_payment" }>,
		plan: StripeRecurringCheckoutPlan | null,
		quantities: Record<string, number>,
	): PaymentSetupRequestParameters {
		return {
			billingAccountId,
			currency: intent.currency,
			email: intent.email ?? null,
			// Hosted setup returns to the configured customer application, checked against the
			// connection's approved origins exactly as Checkout and portal returns are.
			successUrl: this.returnUrl(intent.successUrl, this.dependencies.config.checkoutSuccessUrl),
			cancelUrl: this.returnUrl(intent.cancelUrl, this.dependencies.config.checkoutCancelUrl),
			providerAccountId: this.providerAccountIdentity(),
			integrationIdentifier: this.dependencies.config.integrationIdentifier ?? "qfmxzjpa",
			plan:
				plan === null
					? null
					: { planKey: plan.planKey, planVersionId: plan.planVersionId, quantities },
		};
	}

	private paymentSetupContext(): PaymentSetupContext {
		const taxMode = this.dependencies.config.taxMode ?? "disabled";
		return {
			client: this.dependencies.client,
			repository: this.dependencies.repository,
			taxMode,
			startPlanOnSavedCard: (setup, workerId) =>
				startPlanOnSavedCard(
					{
						...this.savedCardPlanContext(taxMode),
						recordSubscription: async (subscription) => {
							const result = await this.recordProviderSubscription(
								subscription,
								`payment_setup_plan:${setup.id}`,
							);
							if (result.processingStatus !== "processed") {
								throw new BillingError(
									"Stripe subscription was not recorded",
									"STRIPE_PAYMENT_SETUP_INCOMPLETE",
									502,
								);
							}
						},
					},
					setup,
					workerId,
				),
		};
	}

	private savedCardPlanContext(taxMode: "disabled" | "test" | "registered"): SavedCardPlanContext {
		const repository = this.dependencies.repository;
		const recordSubscriptionId = repository.recordPaymentSetupSubscriptionId?.bind(repository);
		const recordOutcome = repository.recordPaymentSetupPlanOutcome?.bind(repository);
		if (recordSubscriptionId === undefined || recordOutcome === undefined) {
			throw new BillingError(
				"Payment method setup is not configured",
				"STRIPE_NOT_CONFIGURED",
				503,
			);
		}
		return {
			client: this.dependencies.client,
			repository: {
				getStripeRecurringCheckoutPlanByKey: (planKey, billingAccountId) =>
					requireRecurringPlanRepository(repository)(planKey, billingAccountId),
				hasActiveBasePlan: (billingAccountId) =>
					requireActiveBasePlanRepository(repository)(billingAccountId),
				recordPaymentSetupSubscriptionId: recordSubscriptionId,
				recordPaymentSetupPlanOutcome: recordOutcome,
			},
			subscriptionCreateParams: (plan, quantities, setup) =>
				paymentSetupSubscriptionParams(plan, quantities, setup, taxMode),
			recordSubscription: async () => {
				throw new BillingError(
					"Payment method setup is not configured",
					"STRIPE_NOT_CONFIGURED",
					503,
				);
			},
		};
	}

	private providerAccountIdentity(): string | null {
		return this.dependencies.config.accountIdentity ?? null;
	}

	/**
	 * Builds the preview for a cancel or uncancel from local state alone. Nothing is read from
	 * Stripe: the subscription row, its queued change and its add-ons are what the action acts on,
	 * and they are exactly what the fingerprint binds the execution to.
	 */
	private async cancellationPreviewDraft(
		billingAccountId: string,
		intent: CancellationIntent,
		intentHash: string,
	): Promise<CommercialPreviewDraft> {
		const read = this.dependencies.repository.previewSubscriptionCancellation;
		if (read === undefined) {
			throw new BillingError(
				"Commercial previews are not configured",
				"STRIPE_NOT_CONFIGURED",
				503,
			);
		}
		const context = await read.call(this.dependencies.repository, {
			billingAccountId,
			externalSubscriptionId: intent.externalSubscriptionId,
		});
		const cancellation = resolveCancellationPreview(intent, context);
		return {
			billingAccountId,
			intent,
			intentHash,
			stateFingerprint: context.stateFingerprint,
			providerStateFingerprint: context.stateFingerprint,
			promotion: null,
			preview: {
				schemaVersion: 1,
				intentHash,
				stateFingerprint: context.stateFingerprint,
				billingAccountId,
				action: cancellation.action === "none" ? "none" : intent.kind,
				provider: commercialPreviewProvider(stripeCapabilities, intent),
				lineItems: [],
				estimatedTotalMinor: 0,
				subtotalMinor: 0,
				discountTotalMinor: 0,
				currency: null,
				amountStatus: "exact",
				promotionCodeEntry: "none",
				promotion: null,
				nextCycle: null,
				cancellation,
				paymentSetup: null,
				effectiveMode: intent.kind === "cancel" ? intent.effectiveMode : null,
				effectiveAt: cancellation.accessEndsAt,
				prorationBehavior: intent.kind === "cancel" ? "none" : null,
				changeKind: null,
				fromPlanVersionId: context.planVersionId,
				toPlanVersionId: null,
				targetId: context.externalSubscriptionId,
				warnings: cancellationWarnings(cancellation),
			},
		};
	}

	/**
	 * Performs a cancellation and records it. The provider call comes first and the local write
	 * second, so a superseded change is never recorded for a cancellation Stripe refused; replaying
	 * the same execution key is safe because Stripe is idempotent and the local write is conditional.
	 */
	private async executeSubscriptionCancellation(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
		intent: CancellationIntent;
		cancellation: CommercialPreviewCancellation;
	}): Promise<CommercialActionExecutionResult> {
		const complete = this.dependencies.repository.completeSubscriptionCancellation;
		if (complete === undefined) {
			throw new BillingError("Commercial actions are not configured", "STRIPE_NOT_CONFIGURED", 503);
		}
		const { intent, cancellation } = input;
		const executionKey = commercialExecutionKey(input.previewToken, input.idempotencyKey);
		const idempotencyKey = `billing:subscription-cancel:${executionKey}`;
		if (cancellation.action === "cancel" && intent.kind === "cancel") {
			if (intent.effectiveMode === "immediate") {
				const cancel = this.dependencies.client.cancelSubscription;
				if (cancel === undefined) {
					throw new Error("Stripe subscription cancellation is unavailable");
				}
				await cancel.call(this.dependencies.client, intent.externalSubscriptionId, idempotencyKey);
			} else {
				await this.updateCancelAtPeriodEnd(intent.externalSubscriptionId, true, idempotencyKey);
			}
		} else if (cancellation.action === "uncancel") {
			await this.updateCancelAtPeriodEnd(intent.externalSubscriptionId, false, idempotencyKey);
		}
		return await complete.call(this.dependencies.repository, {
			billingAccountId: input.billingAccountId,
			previewToken: input.previewToken,
			idempotencyKey: input.idempotencyKey,
			externalSubscriptionId: intent.externalSubscriptionId,
			supersedeReason: `Superseded by the cancellation of subscription ${intent.externalSubscriptionId}`,
			supersedesPendingChange:
				cancellation.action === "cancel" && cancellation.supersedesChangeId !== null,
			result: {
				kind: "subscription_cancellation",
				action: cancellation.action,
				externalSubscriptionId: intent.externalSubscriptionId,
				effectiveMode: intent.kind === "cancel" ? intent.effectiveMode : null,
				effectiveAt: cancellation.accessEndsAt,
				cancelAtPeriodEnd: cancellation.cancelAtPeriodEnd,
			},
		});
	}

	private async updateCancelAtPeriodEnd(
		externalSubscriptionId: string,
		cancelAtPeriodEnd: boolean,
		idempotencyKey: string,
	): Promise<void> {
		if (this.dependencies.client.updateSubscription === undefined) {
			throw new Error("Stripe subscription updates are unavailable");
		}
		await this.dependencies.client.updateSubscription(
			externalSubscriptionId,
			{ cancel_at_period_end: cancelAtPeriodEnd },
			idempotencyKey,
		);
	}

	private async commercialPromotion(
		billingAccountId: string,
		code: string | null | undefined,
		target: PromotionTarget,
	): Promise<CommercialPromotion | null> {
		if (code === undefined || code === null) return null;
		const repository = this.dependencies.repository;
		if (repository.resolveCommercialPromotion === undefined) {
			throw promotionError("PROMOTION_PROVIDER_NOT_READY");
		}
		return await repository.resolveCommercialPromotion({ billingAccountId, code, target });
	}

	async applySubscriptionChange(operation: SubscriptionChangeOperation): Promise<string> {
		if (this.dependencies.client.updateSubscription === undefined) {
			throw new Error("Stripe subscription updates are unavailable");
		}
		const items: Stripe.SubscriptionUpdateParams.Item[] = operation.items.map((item) =>
			item.deleted === true
				? { id: item.providerSubscriptionItemId, deleted: true }
				: {
						id: item.providerSubscriptionItemId,
						price: item.externalPriceId,
						quantity: item.quantity,
					},
		);
		let discounts: Stripe.SubscriptionUpdateParams.Discount[] | undefined;
		if (operation.discountCouponId !== null) {
			if (this.dependencies.client.retrieveSubscriptionDiscounts === undefined) {
				throw new Error("Stripe subscription discounts are unavailable");
			}
			// Stripe replaces the whole discount list on update, so existing discounts are resent.
			const existing = await this.dependencies.client.retrieveSubscriptionDiscounts(
				operation.externalSubscriptionId,
			);
			discounts = [
				...existing.map((discount) => ({ discount: discount.id })),
				...(existing.some((discount) => discount.couponId === operation.discountCouponId)
					? []
					: [{ coupon: operation.discountCouponId }]),
			];
		}
		const subscription = await this.dependencies.client.updateSubscription(
			operation.externalSubscriptionId,
			{
				items,
				proration_behavior: operation.prorationBehavior,
				metadata: {
					planVersionId: operation.targetPlanVersionId,
					billingChangeId: operation.changeId,
				},
				...(discounts === undefined ? {} : { discounts }),
			},
			discounts === undefined
				? `billing:subscription-change:${operation.changeId}`
				: `billing:subscription-change:${operation.changeId}:discounts:${sha256Hex(stableJson(discounts)).slice(0, 16)}`,
		);
		return subscription.id;
	}

	async createUsageInvoice(job: UsageInvoiceJob): Promise<string> {
		if (
			this.dependencies.client.createInvoice === undefined ||
			this.dependencies.client.addInvoiceLines === undefined ||
			this.dependencies.client.finalizeInvoice === undefined ||
			this.dependencies.client.payInvoice === undefined
		) {
			throw new Error("Stripe invoice operations are unavailable");
		}
		const metadata = {
			billingAccountId: job.billingAccountId,
			usageInvoicePeriodId: job.periodId,
			usageInvoiceJobKind: job.jobKind,
			...(job.adjustmentId === null ? {} : { usageInvoiceAdjustmentId: job.adjustmentId }),
			featureKey: job.featureKey,
		};
		// A usage window can close after its subscription ended: an immediate cancellation, here or
		// in the portal, leaves the last period's overage owed with nothing left to invoice against.
		// Stripe's invoice `subscription` expects a live subscription, and an invoice without an
		// explicit method falls back to the subscription's, which ends with it, so the late charge is
		// billed to the customer against their saved default method instead.
		const subscriptionEnded = !liveStripeSubscriptionStatuses.has(job.subscriptionStatus);
		// A late correction is always a credit and is never collected, so it needs no payment
		// method; demanding one would strand the credit of a customer who has none saved.
		const endedPaymentMethod =
			subscriptionEnded && job.amountMinor > 0
				? await this.endedSubscriptionPaymentMethod(job)
				: null;
		const invoiceParams: Stripe.InvoiceCreateParams = {
			customer: job.externalCustomerId,
			...(subscriptionEnded
				? endedPaymentMethod === null
					? {}
					: { default_payment_method: endedPaymentMethod }
				: { subscription: job.externalSubscriptionId }),
			currency: job.currency,
			collection_method: "charge_automatically",
			auto_advance: false,
			pending_invoice_items_behavior: "exclude",
			metadata,
		};
		if ((this.dependencies.config.taxMode ?? "disabled") !== "disabled") {
			invoiceParams.automatic_tax = { enabled: true };
		}
		const invoice = await this.dependencies.client.createInvoice(
			invoiceParams,
			`billing:usage-invoice:${job.jobKind}:${job.jobId}:create`,
		);
		const description =
			job.jobKind === "period"
				? `${job.featureKey} overage (${job.billableQuantity} billable; ${job.includedQuantity} included)`
				: `${job.featureKey} late usage correction (${job.adjustmentQuantity ?? "0"})`;
		const line: Stripe.InvoiceAddLinesParams.Line = {
			quantity: 1,
			description,
			period: {
				start: Math.floor(new Date(job.periodStartAt).getTime() / 1000),
				end: Math.floor(new Date(job.periodEndAt).getTime() / 1000) - 1,
			},
			metadata,
		};
		if (job.jobKind === "period") {
			line.price_data = {
				currency: job.currency,
				product: job.externalProductId,
				unit_amount: job.amountMinor,
			};
		} else {
			line.amount = job.amountMinor;
		}
		await this.dependencies.client.addInvoiceLines(
			invoice.id,
			{ lines: [line] },
			`billing:usage-invoice:${job.jobKind}:${job.jobId}:line`,
		);
		await this.dependencies.client.finalizeInvoice(
			invoice.id,
			`billing:usage-invoice:${job.jobKind}:${job.jobId}:finalize`,
		);
		if (job.amountMinor > 0) {
			await this.dependencies.client.payInvoice(
				invoice.id,
				`billing:usage-invoice:${job.jobKind}:${job.jobId}:pay`,
			);
		}
		return invoice.id;
	}

	/**
	 * Resolves the customer's saved default payment method for a charge that has outlived its
	 * subscription. A customer without one cannot be charged automatically, so the job fails and
	 * retries into its own terminal outcome rather than dropping the amount owed.
	 */
	private async endedSubscriptionPaymentMethod(job: UsageInvoiceJob): Promise<string> {
		if (this.dependencies.client.retrieveDefaultPaymentMethod === undefined) {
			throw new Error("Stripe customer retrieval is unavailable");
		}
		const paymentMethodId = await this.dependencies.client.retrieveDefaultPaymentMethod(
			job.externalCustomerId,
		);
		if (paymentMethodId === null) {
			throw new Error(
				`A saved default payment method is required to invoice usage after subscription ${job.externalSubscriptionId} ended`,
			);
		}
		return paymentMethodId;
	}

	async createAutoTopupCharge(job: AutoTopupJob): Promise<AutoTopupChargeResult> {
		if (job.externalCustomerId === null) {
			return {
				status: "action_required",
				externalInvoiceId: null,
				externalPaymentId: null,
				reason: "A linked Stripe customer is required for automatic top-ups",
			};
		}
		if (job.externalPriceId === null) {
			return {
				status: "action_required",
				externalInvoiceId: null,
				externalPaymentId: null,
				reason: "The automatic top-up price is unavailable",
			};
		}
		if (
			this.dependencies.client.retrieveDefaultPaymentMethod === undefined ||
			this.dependencies.client.createInvoice === undefined ||
			this.dependencies.client.addInvoiceLines === undefined ||
			this.dependencies.client.finalizeInvoice === undefined ||
			this.dependencies.client.payInvoice === undefined ||
			this.dependencies.client.voidInvoice === undefined
		) {
			throw new Error("Stripe automatic top-up operations are unavailable");
		}
		const paymentMethodId = await this.dependencies.client.retrieveDefaultPaymentMethod(
			job.externalCustomerId,
		);
		if (paymentMethodId === null) {
			return {
				status: "action_required",
				externalInvoiceId: null,
				externalPaymentId: null,
				reason: "A saved default payment method is required for automatic top-ups",
			};
		}
		const metadata = {
			billingAccountId: job.billingAccountId,
			autoTopupJobId: job.jobId,
			autoTopupPolicyId: job.policyId,
		};
		const invoiceParams: Stripe.InvoiceCreateParams = {
			customer: job.externalCustomerId,
			currency: job.currency.toLowerCase(),
			collection_method: "charge_automatically",
			auto_advance: false,
			pending_invoice_items_behavior: "exclude",
			default_payment_method: paymentMethodId,
			metadata,
		};
		if ((this.dependencies.config.taxMode ?? "disabled") !== "disabled") {
			invoiceParams.automatic_tax = { enabled: true };
		}
		const scope = `billing:auto-topup:${job.jobId}`;
		const invoice = await this.dependencies.client.createInvoice(invoiceParams, `${scope}:create`);
		await this.dependencies.client.addInvoiceLines(
			invoice.id,
			{
				lines: [
					{
						pricing: { price: job.externalPriceId },
						quantity: 1,
						description: "Automatic balance top-up",
						metadata,
					},
				],
			},
			`${scope}:line`,
		);
		const finalized = invoiceReceipt(
			await this.dependencies.client.finalizeInvoice(invoice.id, `${scope}:finalize`),
		);
		if (finalized.total > job.maximumChargeMinor) {
			await this.dependencies.client.voidInvoice(invoice.id, `${scope}:void-safety-limit`);
			return {
				status: "safety_limit_exceeded",
				externalInvoiceId: invoice.id,
				externalPaymentId: finalized.externalPaymentId,
				reason: "The finalized Stripe invoice exceeded the automatic top-up safety budget",
			};
		}
		let paidRaw: unknown;
		try {
			paidRaw = await this.dependencies.client.payInvoice(invoice.id, `${scope}:pay`);
		} catch (error) {
			if (!stripePaymentActionRequired(error)) throw error;
			return {
				status: "action_required",
				externalInvoiceId: invoice.id,
				externalPaymentId: stripeErrorPaymentIntentId(error),
				reason: errorMessage(error).slice(0, 2_000),
			};
		}
		const paid = invoiceReceipt(paidRaw);
		if (paid.status !== "paid") {
			throw new Error(
				`Stripe automatic top-up invoice ${invoice.id} is ${paid.status ?? "unpaid"}`,
			);
		}
		if (paid.currency.toUpperCase() !== job.currency.toUpperCase()) {
			throw new Error("Stripe automatic top-up invoice currency changed unexpectedly");
		}
		return {
			status: "succeeded",
			externalInvoiceId: invoice.id,
			externalPaymentId: paid.externalPaymentId,
			amountPaidMinor: paid.amountPaid,
			currency: paid.currency.toUpperCase(),
		};
	}

	async createPortalSession(input: {
		billingAccountId: string;
		returnUrl?: string | null;
	}): Promise<StripePortalSessionResult> {
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const stripeCustomerId = await this.getOrCreateCustomer(billingAccountId, null);
		const session = await this.dependencies.client.createPortalSession({
			customer: stripeCustomerId,
			return_url: this.returnUrl(input.returnUrl, this.dependencies.config.portalReturnUrl),
		});

		return { url: session.url };
	}

	async expireCheckoutSession(input: {
		billingAccountId: string;
		sessionId: string;
	}): Promise<StripeCheckoutSessionStatus> {
		const current = await this.getCheckoutSessionStatus(input);
		if (current.status !== "open") return current;
		if (!this.dependencies.client.expireCheckoutSession)
			throw new BillingError("Checkout expiration is unavailable", "STRIPE_NOT_CONFIGURED", 503);
		try {
			await this.dependencies.client.expireCheckoutSession(input.sessionId);
		} catch (error) {
			const latest = await this.getCheckoutSessionStatus(input);
			if (latest.status !== "open") return latest;
			throw error;
		}
		return this.getCheckoutSessionStatus(input);
	}

	async getCheckoutSessionStatus(input: {
		billingAccountId: string;
		sessionId: string;
	}): Promise<StripeCheckoutSessionStatus> {
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const sessionId = requireNonBlank(input.sessionId, "sessionId");
		const session = await this.dependencies.client.retrieveCheckoutSession(sessionId);
		const clientReferenceBillingAccountId = optionalNonBlankString(session.client_reference_id);
		const metadataBillingAccountId = optionalNonBlankString(session.metadata?.billingAccountId);

		if (
			(clientReferenceBillingAccountId !== null &&
				metadataBillingAccountId !== null &&
				clientReferenceBillingAccountId !== metadataBillingAccountId) ||
			(clientReferenceBillingAccountId ?? metadataBillingAccountId) !== billingAccountId
		) {
			throw new BillingError(
				"Stripe Checkout session does not belong to customer",
				"INVALID_REQUEST",
				403,
			);
		}

		const status = checkoutPaymentStatus(session.payment_status);

		return {
			sessionId: session.id,
			status: checkoutStatus(session.status),
			paymentStatus: status,
			customerEmail: paidCheckoutEmail(session, status),
			productKey: paidCheckoutProductKey(session, status),
		};
	}

	private returnUrl(
		requested: string | null | undefined,
		fallback: string,
		options: { requireCheckoutPlaceholder?: boolean } = {},
	): string {
		const value = requested ?? fallback;
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new BillingError("Return URL is invalid", "RETURN_URL_NOT_ALLOWED", 400);
		}
		const allowedOrigins =
			this.dependencies.config.allowedReturnOrigins ??
			defaultReturnOrigins(this.dependencies.config);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username !== "" ||
			url.password !== "" ||
			!allowedOrigins.includes(url.origin)
		) {
			throw new BillingError("Return URL origin is not allowed", "RETURN_URL_NOT_ALLOWED", 400);
		}
		if (options.requireCheckoutPlaceholder && !value.includes("{CHECKOUT_SESSION_ID}")) {
			throw new BillingError(
				"Stripe success URL must include the Checkout session placeholder",
				"RETURN_URL_NOT_ALLOWED",
				400,
			);
		}
		return value;
	}

	async handleWebhook(input: {
		rawBody: string;
		signatureHeader: string | null;
	}): Promise<StripeWebhookResult> {
		const signature = requireNonBlank(input.signatureHeader ?? "", "Stripe signature");
		let event: unknown;

		try {
			event = await this.dependencies.client.constructWebhookEvent(input.rawBody, signature);
		} catch (error) {
			if (error instanceof BillingError) {
				throw error;
			}

			throw new BillingError(
				"Stripe webhook signature is invalid",
				"STRIPE_WEBHOOK_SIGNATURE_INVALID",
				400,
			);
		}

		return this.handleVerifiedAppEvent(event);
	}
	/** Only composition's signature-verified, account-mapped app event inbox may call this entrypoint. */
	async handleVerifiedAppEvent(event: unknown): Promise<StripeWebhookResult> {
		const expected = this.dependencies.config.connectedAccountId;
		if (
			expected &&
			(!event ||
				typeof event !== "object" ||
				!("account" in event) ||
				event.account !== expected ||
				!("livemode" in event) ||
				event.livemode !== this.dependencies.config.connectedAccountLivemode)
		)
			throw new BillingError(
				"Stripe account or mode does not match this connection",
				"STRIPE_ACCOUNT_MISMATCH",
				400,
			);
		return this.processEvent(event);
	}

	async replayStoreEvent(
		event: StoreEventReplayJobRow,
		options?: { maxAttempts: number },
	): Promise<StoreEventReplayProviderResult> {
		if (event.provider !== "stripe" || event.channel !== "web") {
			throw new BillingError("Store event is not a Stripe web event", "INVALID_REQUEST", 400);
		}

		if (event.event_type === paymentSetupReconcileEventType) {
			return await this.runPaymentSetupReconciliation(event, options?.maxAttempts);
		}

		const storedEvent = stripeEventFromStoredEvent(event);
		const paymentSetup = normalizePaymentSetupEvent(parseStripeEvent(storedEvent));
		if (paymentSetup !== null) {
			return await applyPaymentSetupEvent(this.paymentSetupContext(), {
				event: paymentSetup,
				workerId: workerIdOf(event),
			});
		}

		const result = await this.processEvent(storedEvent, event.id);

		if (result.status === "processed") {
			return { status: "processed" };
		}

		if (result.status === "ignored") {
			return { status: "ignored", reason: "stripe_store_event_not_recordable" };
		}

		return { status: "retryable", reason: "stripe_recording_skipped" };
	}

	async reconcileSubscription(
		subscription: ProviderSubscriptionReconciliationRow,
	): Promise<{ status: "processed" | "skipped" }> {
		if (subscription.provider !== "stripe" || subscription.channel !== "web") {
			throw new BillingError(
				"Provider subscription is not a Stripe web subscription",
				"INVALID_REQUEST",
				400,
			);
		}

		const stripeSubscriptionId = requireNonBlank(
			subscription.external_subscription_id,
			"stripeSubscriptionId",
		);
		const providerSubscription =
			await this.dependencies.client.retrieveSubscription(stripeSubscriptionId);
		const result = await this.recordProviderSubscription(
			requireRecord(providerSubscription, "Stripe subscription"),
			`provider_reconciliation:${stripeSubscriptionId}`,
		);

		return { status: result.processingStatus === "processed" ? "processed" : "skipped" };
	}

	/** Normalizes a Stripe subscription response and records it, the same way reconciliation does. */
	private async recordProviderSubscription(
		subscription: Record<string, unknown>,
		eventId: string,
	): Promise<StripeRecordingResult> {
		const command = normalizeStripeSubscription({
			eventId,
			eventType: "provider_reconciliation",
			subscription,
			projectionReason: "provider_reconciliation",
		});
		return await this.dependencies.repository.recordStripeSubscriptionAndEnqueueProjection({
			...toStripeSubscriptionRepositoryInput(command, {
				externalEventId: null,
				projectionContract: this.projectionContract(),
			}),
			...this.providerAccount(),
		});
	}

	/** The internal task that watches one setup until it completes or its expiry is confirmed. */
	private async runPaymentSetupReconciliation(
		event: StoreEventReplayJobRow,
		maxAttempts?: number,
	): Promise<StoreEventReplayProviderResult> {
		const setupId = optionalNonBlankString(event.raw_payload.quotumPaymentSetupId);
		if (setupId === null) {
			return { status: "ignored", reason: "payment_setup_reconciliation_without_target" };
		}
		return await reconcilePaymentSetup(this.paymentSetupContext(), {
			setupId,
			workerId: workerIdOf(event),
			attempts: event.attempts,
			maxAttempts,
		});
	}

	private async getOrCreateCustomer(
		billingAccountId: string,
		email: string | null,
	): Promise<string> {
		const existingCustomerId = await this.dependencies.repository.getStripeProviderCustomer({
			billingAccountId,
			email,
		});
		if (existingCustomerId !== null) {
			return existingCustomerId;
		}

		const customer = await this.dependencies.client.createCustomer({
			billingAccountId,
			email,
			idempotencyScope: this.dependencies.config.projectKey ?? null,
		});
		return this.dependencies.repository.linkStripeProviderCustomer({
			billingAccountId,
			stripeCustomerId: customer.id,
			email,
			...this.providerAccount(),
		});
	}

	private async processEvent(
		event: unknown,
		replayStoreEventId?: string,
	): Promise<StripeWebhookResult> {
		const parsedEvent = parseStripeEvent(event);
		const paymentSetup = normalizePaymentSetupEvent(parsedEvent);
		if (paymentSetup !== null) {
			// The ingress only puts the event on disk; a lease-holding worker does the provider work.
			return await this.enqueuePaymentSetupEvent(parsedEvent, paymentSetup, event);
		}
		let command: NormalizedStripeCommand | null;

		try {
			command = normalizeSupportedEvent(parsedEvent);
		} catch (error) {
			return this.recordNormalizationFailure(parsedEvent, error, replayStoreEventId);
		}

		if (command === null) {
			return { status: "ignored", eventType: parsedEvent.type, entitlements: null };
		}

		return this.recordCommand(command, replayStoreEventId);
	}

	private async enqueuePaymentSetupEvent(
		parsed: ParsedStripeEvent,
		setup: NormalizedPaymentSetupEvent,
		rawEvent: unknown,
	): Promise<StripeWebhookResult> {
		await enqueuePaymentSetupEvent(this.paymentSetupContext(), {
			externalEventId: parsed.id,
			eventType: parsed.type,
			setup,
			rawEvent: requireRecord(rawEvent, "Stripe event"),
		});
		return { status: "processed", eventType: parsed.type, entitlements: null };
	}

	private async recordCommand(
		command: NormalizedStripeCommand,
		replayStoreEventId?: string,
	): Promise<StripeWebhookResult> {
		switch (command.kind) {
			case "ignored":
				return { status: "ignored", eventType: command.eventType, entitlements: null };
			case "identity_only":
				await this.dependencies.repository.linkStripeProviderCustomer({
					billingAccountId: command.billingAccountId,
					stripeCustomerId: command.stripeCustomerId,
					email: null,
					...this.providerAccount(),
				});
				if (command.promotion !== undefined && command.promotion !== null) {
					await this.dependencies.repository.recordStripeCheckoutPromotion?.({
						billingAccountId: command.billingAccountId,
						promotion: command.promotion,
					});
				}
				return { status: "processed", eventType: command.eventType, entitlements: null };
			case "checkout_promotion_release":
				await this.dependencies.repository.releaseStripeCheckoutPromotion?.({
					checkoutSessionId: command.checkoutSessionId,
					redemptionId: command.redemptionId,
				});
				return { status: "processed", eventType: command.eventType, entitlements: null };
			case "credit_purchase":
				return recordingResultToWebhookResult(
					command.eventType,
					await this.dependencies.repository.recordStripeCreditPurchaseAndEnqueueProjection({
						...toStripeCreditPurchaseRepositoryInput(
							command,
							this.projectionContract(),
							replayStoreEventId,
						),
						...this.providerAccount(),
					}),
				);
			case "subscription":
				return recordingResultToWebhookResult(
					command.eventType,
					await this.dependencies.repository.recordStripeSubscriptionAndEnqueueProjection({
						...toStripeSubscriptionRepositoryInput(command, {
							replayStoreEventId,
							projectionContract: this.projectionContract(),
						}),
						...this.providerAccount(),
					}),
				);
			case "credit_reversal":
				return recordingResultToWebhookResult(
					command.eventType,
					await this.dependencies.repository.recordStripeCreditReversalAndEnqueueProjection(
						toStripeCreditReversalRepositoryInput(
							command,
							this.projectionContract(),
							replayStoreEventId,
						),
					),
				);
		}
	}

	private async recordNormalizationFailure(
		event: ParsedStripeEvent,
		error: unknown,
		replayStoreEventId?: string,
	): Promise<StripeWebhookResult> {
		const result = await this.dependencies.repository.recordStripeSkippedEvent({
			eventType: event.type,
			externalEventId: event.id,
			transactionId: skippedEventTransactionId(event),
			purchaseKind: skippedEventPurchaseKind(event),
			processingError: errorMessage(error),
			rawPayload: event.object,
			replayStoreEventId,
		});

		return recordingResultToWebhookResult(event.type, result);
	}

	private projectionContract(): ProjectionContract {
		return this.dependencies.config.projectionContract ?? "billing_state_v1";
	}

	/** Omitted without an identity, so writes keep their exact shape. */
	private providerAccount(): { providerAccountId?: string } {
		const identity = this.dependencies.config.accountIdentity;
		return identity == null ? {} : { providerAccountId: identity };
	}
}

function normalizeSupportedEvent(event: ParsedStripeEvent): NormalizedStripeCommand | null {
	switch (event.type) {
		case "checkout.session.completed":
		case "checkout.session.async_payment_succeeded":
			return normalizeStripeCheckoutSession({
				eventId: event.id,
				eventType: event.type,
				eventCreated: event.created,
				session: event.object,
			});
		case "checkout.session.expired":
		case "checkout.session.async_payment_failed":
			return normalizeStripeCheckoutSessionTermination({
				eventId: event.id,
				eventType: event.type,
				session: event.object,
			});
		case "invoice.paid":
		case "invoice.payment_failed":
			return normalizeStripeInvoice({
				eventId: event.id,
				eventType: event.type,
				eventCreated: event.created,
				invoice: event.object,
			});
		case "customer.subscription.created":
		case "customer.subscription.updated":
		case "customer.subscription.deleted":
		case "customer.subscription.trial_will_end":
			return normalizeStripeSubscription({
				eventId: event.id,
				eventType: event.type,
				eventCreated: event.created,
				subscription: event.object,
			});
		case "refund.created":
		case "refund.updated":
		case "charge.refunded":
			return normalizeStripeRefund({
				eventId: event.id,
				eventType: event.type,
				refund: event.object,
			});
		case "charge.dispute.created":
			return normalizeStripeDispute({
				eventId: event.id,
				eventType: event.type,
				dispute: event.object,
			});
		default:
			return null;
	}
}

function recordingResultToWebhookResult(
	eventType: string,
	result: StripeRecordingResult,
): StripeWebhookResult {
	return {
		status: result.processingStatus,
		eventType,
		entitlements: result.entitlements,
	};
}

function toStripeCreditPurchaseRepositoryInput(
	command: NormalizedStripeCreditPurchaseCommand,
	projectionContract: ProjectionContract,
	replayStoreEventId?: string,
): RecordStripeCreditPurchaseProjectionInput {
	return {
		purchaseKind: command.purchaseKind,
		billingAccountId: command.billingAccountId,
		stripeCustomerId: command.stripeCustomerId,
		externalProductId: command.externalProductId,
		externalPriceId: command.externalPriceId,
		transactionId: command.transactionId,
		paymentIntentId: command.paymentIntentId,
		chargeId: command.chargeId,
		checkoutSessionId: command.checkoutSessionId,
		promotion: command.promotion ?? null,
		amountPaidCents: command.amountPaidCents,
		currency: command.currency,
		purchasedAt: command.purchasedAt,
		rawPayload: command.rawPayload,
		eventType: command.eventType,
		externalEventId: command.externalEventId,
		projectionIdempotencyKey: command.projectionIdempotencyKey,
		projectionContract,
		replayStoreEventId,
	};
}

function toStripeSubscriptionRepositoryInput(
	command: NormalizedStripeSubscriptionCommand,
	options: {
		externalEventId?: string | null;
		replayStoreEventId?: string;
		projectionContract?: ProjectionContract;
	} = {},
): RecordStripeSubscriptionProjectionInput {
	const externalEventId =
		options.externalEventId === undefined ? command.externalEventId : options.externalEventId;
	return {
		billingAccountId: command.billingAccountId,
		stripeCustomerId: command.stripeCustomerId,
		stripeSubscriptionId: command.stripeSubscriptionId,
		invoiceId: command.invoiceId,
		providerObjectIds: command.providerObjectIds,
		externalProductId: command.externalProductId,
		externalPriceId: command.externalPriceId,
		items: command.items,
		subscriptionStatus: command.subscriptionStatus,
		providerStatus: command.providerStatus,
		purchasedAt: command.purchasedAt,
		startsAt: command.currentPeriodStart,
		expiresAt: command.expiresAt,
		currentPeriodStart: command.currentPeriodStart,
		currentPeriodEnd: command.expiresAt,
		trialStart: command.trialStart,
		trialEnd: command.trialEnd,
		cancelAtPeriodEnd: command.cancelAtPeriodEnd,
		providerEventCreated: command.providerEventCreated,
		invoiceStatus: command.invoiceStatus,
		invoiceAmountPaid: command.invoiceAmountPaid,
		invoiceCurrency: command.invoiceCurrency,
		invoicePaidAt: command.invoicePaidAt,
		autoRenew: command.autoRenew,
		rawPayload: command.rawPayload,
		eventType: command.eventType,
		externalEventId,
		projectionReason: command.projectionReason,
		projectionIdempotencyKey: command.projectionIdempotencyKey,
		projectionContract: options.projectionContract,
		replayStoreEventId: options.replayStoreEventId,
		trialNotice: command.trialNotice,
	};
}

function toStripeCreditReversalRepositoryInput(
	command: NormalizedStripeCreditReversalCommand,
	projectionContract: ProjectionContract,
	replayStoreEventId?: string,
): RecordStripeCreditReversalProjectionInput {
	return {
		reversalReason: command.reversalReason,
		reversalId: command.reversalId,
		reversalAmount: command.reversalAmount,
		reversalCurrency: command.reversalCurrency,
		paymentIntentId: command.paymentIntentId,
		chargeId: command.chargeId,
		reversedAt: command.reversedAt,
		rawPayload: command.rawPayload,
		eventType: command.eventType,
		externalEventId: command.externalEventId,
		projectionIdempotencyKey: command.projectionIdempotencyKey,
		projectionContract,
		replayStoreEventId,
	};
}

function checkoutModeFor(product: StripeWebStoreProductRow): StripeCheckoutMode {
	if (product.productType === "consumable" || product.productType === "non_consumable") {
		return "payment";
	}
	if (product.productType === "subscription") {
		return "subscription";
	}

	throw new BillingError(
		"Stripe web product type is not supported for Checkout",
		"INVALID_REQUEST",
		400,
	);
}

function checkoutMetadata(
	billingAccountId: string,
	product: StripeWebStoreProductRow,
): Record<string, string> {
	return {
		billingAccountId,
		productKey: product.productKey,
		storeProductId: product.storeProductId,
		purchaseKind: product.productType,
		billingEnvironment: "web",
		externalProductId: product.externalProductId,
		externalPriceId: product.externalPriceId,
	};
}

/**
 * The subscriptions.create call that starts a plan on the card setup just saved. No subscription
 * payment method is sent: the customer default was just set to that card. A trial uses the same
 * end behavior Checkout would.
 */
export function paymentSetupSubscriptionParams(
	plan: StripeRecurringCheckoutPlan,
	quantities: Record<string, number>,
	setup: { id: string; billing_account_id: string; provider_customer_id: string },
	taxMode: "disabled" | "test" | "registered",
): Stripe.SubscriptionCreateParams {
	const params: Stripe.SubscriptionCreateParams = {
		customer: setup.provider_customer_id,
		items: recurringCheckoutLines(plan, quantities),
		metadata: {
			...recurringCheckoutMetadata(setup.billing_account_id, plan),
			[PAYMENT_SETUP_METADATA_KEY]: setup.id,
		},
		payment_behavior: "error_if_incomplete",
		off_session: true,
		proration_behavior: "none",
	};
	if (taxMode !== "disabled") {
		params.automatic_tax = { enabled: true };
	}
	if (planTrialApplies(plan) && plan.trialDays !== null) {
		params.trial_period_days = plan.trialDays;
		params.trial_settings = {
			end_behavior: { missing_payment_method: plan.trialEndBehavior },
		};
	}
	return params;
}

function recurringCheckoutMetadata(
	billingAccountId: string,
	plan: StripeRecurringCheckoutPlan,
): Record<string, string> {
	const primary =
		plan.components.find((component) => component.componentKind === "base") ??
		plan.components.find((component) => component.componentKind === "licensed");
	if (primary === undefined) {
		throw new Error(`Plan ${plan.planKey} has no Checkout component`);
	}
	return {
		billingAccountId,
		productKey: plan.planKey,
		planKey: plan.planKey,
		planVersionId: plan.planVersionId,
		purchaseKind: "subscription",
		billingEnvironment: "web",
		externalProductId: primary.externalProductId,
		externalPriceId: primary.externalPriceId,
	};
}

function normalizedLicensedQuantities(value: Record<string, number>): Record<string, number> {
	const normalized: Record<string, number> = {};
	for (const [rawKey, quantity] of Object.entries(value).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const key = requireNonBlank(rawKey, "quantity feature key");
		if (!Number.isSafeInteger(quantity) || quantity < 1) {
			throw new BillingError(
				`Quantity for ${key} must be a positive integer`,
				"INVALID_QUANTITY",
				400,
			);
		}
		normalized[key] = quantity;
	}
	return normalized;
}

function recurringCheckoutLines(
	plan: StripeRecurringCheckoutPlan,
	quantities: Record<string, number>,
): Array<{ price: string; quantity: number }> {
	const licensedKeys = new Set(
		plan.components.flatMap((component) =>
			component.componentKind === "licensed" && component.featureKey !== null
				? [component.featureKey]
				: [],
		),
	);
	for (const key of Object.keys(quantities)) {
		if (!licensedKeys.has(key)) {
			throw new BillingError(
				`Quantity ${key} is not a licensed item on plan ${plan.planKey}`,
				"INVALID_QUANTITY",
				400,
			);
		}
	}
	return plan.components.flatMap((component) => {
		if (component.componentKind === "metered_overage") return [];
		const quantity =
			component.componentKind === "base"
				? 1
				: component.featureKey === null
					? component.defaultQuantity
					: quantities[component.featureKey];
		if (quantity === undefined) {
			throw new BillingError(
				`Explicit quantity is required for ${component.featureKey ?? component.priceKey}`,
				"QUANTITY_REQUIRED",
				400,
			);
		}
		if (
			quantity < component.minimumQuantity ||
			(component.maximumQuantity !== null && quantity > component.maximumQuantity)
		) {
			throw new BillingError(
				`Quantity for ${component.featureKey ?? component.priceKey} is outside the configured range`,
				"INVALID_QUANTITY",
				400,
			);
		}
		return [{ price: component.externalPriceId, quantity }];
	});
}

function commercialPlanLines(
	plan: StripeRecurringCheckoutPlan,
	quantities: Record<string, number>,
): CommercialActionPreview["lineItems"] {
	const stripeLines = recurringCheckoutLines(plan, quantities);
	return stripeLines.map((line) => {
		const component = plan.components.find((candidate) => candidate.externalPriceId === line.price);
		if (component === undefined) throw new Error(`Stripe price ${line.price} was not found`);
		return {
			key: component.priceKey,
			label: component.featureKey ?? plan.name,
			quantity: line.quantity,
			unitAmountMinor: component.unitAmountMinor,
			currency: component.currency,
			interval: component.billingInterval,
			pricingModel: component.pricingModel,
		};
	});
}

/**
 * Decides what a cancel or uncancel would do, and refuses what it cannot do. A cancellation is a
 * state, not a queue: asking for a state that already holds is `none` rather than an error, so a
 * retried request is safe.
 */
function resolveCancellationPreview(
	intent: CancellationIntent,
	context: SubscriptionCancellationContext,
): CommercialPreviewCancellation {
	if (!liveStripeSubscriptionStatuses.has(context.status)) {
		throw new BillingError(
			`Subscription ${context.externalSubscriptionId} is ${context.status} and can no longer be cancelled`,
			"SUBSCRIPTION_NOT_CANCELLABLE",
			409,
			{ details: { subscriptionStatus: context.status } },
		);
	}
	const base = {
		keepsGrantedAllocations: true,
		postpaidUsageSettlesAt: context.postpaidUsageSettlesAt,
		activeAddOnSubscriptionIds: context.activeAddOnSubscriptionIds,
	};
	if (intent.kind === "uncancel") {
		return {
			...base,
			action: context.cancelAtPeriodEnd ? "uncancel" : "none",
			accessEndsAt: context.cancelAtPeriodEnd ? null : null,
			cancelAtPeriodEnd: false,
			supersedesChangeId: null,
		};
	}
	if (context.planKind === "base" && context.activeAddOnSubscriptionIds.length > 0) {
		throw new BillingError(
			"Cancel the account's add-on subscriptions before cancelling its base plan",
			"ADDON_SUBSCRIPTIONS_ACTIVE",
			409,
			{ details: { addOnSubscriptionIds: context.activeAddOnSubscriptionIds } },
		);
	}
	// A change a worker already holds decides its own fate under its lease, so the cancellation
	// waits rather than racing it.
	if (context.pendingChange?.status === "processing") {
		throw new BillingError(
			"Another subscription change is already being applied",
			"SUBSCRIPTION_CHANGE_PENDING",
			409,
		);
	}
	const supersedesChangeId = context.pendingChange?.id ?? null;
	if (intent.effectiveMode === "immediate") {
		return {
			...base,
			action: "cancel",
			accessEndsAt: new Date().toISOString(),
			cancelAtPeriodEnd: false,
			supersedesChangeId,
		};
	}
	if (context.currentPeriodEnd === null) {
		throw new BillingError(
			"Period-end cancellations require a current subscription period end",
			"SUBSCRIPTION_PERIOD_MISSING",
			409,
		);
	}
	return {
		...base,
		action: context.cancelAtPeriodEnd ? "none" : "cancel",
		accessEndsAt: context.currentPeriodEnd,
		cancelAtPeriodEnd: true,
		supersedesChangeId: context.cancelAtPeriodEnd ? null : supersedesChangeId,
	};
}

/** What the caller should know before executing; the approved rules, stated for this subscription. */
function cancellationWarnings(cancellation: CommercialPreviewCancellation): string[] {
	if (cancellation.action === "none") return [];
	if (cancellation.action === "uncancel") {
		return ["Uncancelling does not restore a subscription change the cancellation superseded."];
	}
	return [
		"Plan allocations already granted for the paid period stay spendable until their own expiry.",
		...(cancellation.postpaidUsageSettlesAt === null
			? []
			: [
					`Postpaid usage in the open period is not accelerated; it settles at ${cancellation.postpaidUsageSettlesAt}.`,
				]),
		...(cancellation.supersedesChangeId === null
			? []
			: [`Subscription change ${cancellation.supersedesChangeId} will be cancelled.`]),
	];
}

/** Statuses in which Stripe still holds a subscription that can carry an invoice or a change. */
const liveStripeSubscriptionStatuses: ReadonlySet<SubscriptionStatus> = new Set([
	"active",
	"grace_period",
	"billing_retry",
]);

function normalizeCommercialIntent(intent: CommercialActionIntent): CommercialActionIntent {
	if (intent.kind === "cancel") {
		return {
			kind: intent.kind,
			externalSubscriptionId: requireNonBlank(
				intent.externalSubscriptionId,
				"externalSubscriptionId",
			),
			effectiveMode: intent.effectiveMode,
		};
	}
	if (intent.kind === "uncancel") {
		return {
			kind: intent.kind,
			externalSubscriptionId: requireNonBlank(
				intent.externalSubscriptionId,
				"externalSubscriptionId",
			),
		};
	}
	if (intent.kind === "subscription_change") {
		return {
			kind: intent.kind,
			externalSubscriptionId: requireNonBlank(
				intent.externalSubscriptionId,
				"externalSubscriptionId",
			),
			targetPlanKey: requireNonBlank(intent.targetPlanKey, "targetPlanKey"),
			quantities: normalizedLicensedQuantities(intent.quantities),
			...(intent.effectiveMode === undefined ? {} : { effectiveMode: intent.effectiveMode }),
			...(intent.prorationBehavior === undefined
				? {}
				: { prorationBehavior: intent.prorationBehavior }),
			...(intent.promotionCode === undefined || intent.promotionCode === null
				? {}
				: { promotionCode: normalizePromotionCode(intent.promotionCode) }),
		};
	}
	if (intent.kind === "setup_payment") {
		return {
			kind: intent.kind,
			currency: normalizePaymentSetupCurrency(intent.currency),
			email: optionalNonBlankString(intent.email) ?? null,
			successUrl: optionalNonBlankString(intent.successUrl) ?? null,
			cancelUrl: optionalNonBlankString(intent.cancelUrl) ?? null,
			...(intent.plan === undefined
				? {}
				: {
						plan: {
							planKey: requireNonBlank(intent.plan.planKey, "planKey"),
							quantities: normalizedLicensedQuantities(intent.plan.quantities),
						},
					}),
		};
	}
	const promotionCode =
		intent.promotionCode === undefined || intent.promotionCode === null
			? null
			: normalizePromotionCode(intent.promotionCode);
	if (promotionCode !== null && intent.allowPromotionCodes === true) {
		throw promotionError("PROMOTION_CODE_ENTRY_CONFLICT");
	}
	const common = {
		email: optionalNonBlankString(intent.email) ?? null,
		successUrl: optionalNonBlankString(intent.successUrl) ?? null,
		cancelUrl: optionalNonBlankString(intent.cancelUrl) ?? null,
		...(intent.expiresAt === undefined ? {} : { expiresAt: intent.expiresAt }),
		...(promotionCode === null ? {} : { promotionCode }),
		...(intent.allowPromotionCodes === true ? { allowPromotionCodes: true } : {}),
	};
	return intent.kind === "checkout_plan"
		? {
				kind: intent.kind,
				planKey: requireNonBlank(intent.planKey, "planKey"),
				quantities: normalizedLicensedQuantities(intent.quantities),
				...common,
			}
		: {
				kind: intent.kind,
				productKey: requireNonBlank(intent.productKey, "productKey"),
				...common,
			};
}

/** Adds promotion state to a preview fingerprint only when a code is used, so other hashes hold. */
function promotionFingerprint(base: string, promotion: CommercialPromotion | null): string {
	return promotion === null
		? base
		: sha256Hex(stableJson({ base, promotion: promotion.fingerprint }));
}

function recurringIntervalOf(billingPeriod: string): "month" | "year" | null {
	return billingPeriod === "month" || billingPeriod === "year" ? billingPeriod : null;
}

/** A reservation outlives its Checkout Session by an hour so the completion webhook still finds it. */
function checkoutReservationDeadline(expiresAt: number | undefined): Date {
	const sessionEnd = expiresAt === undefined ? Date.now() + 24 * 60 * 60_000 : expiresAt * 1000;
	return new Date(sessionEnd + 60 * 60_000);
}

function oneCurrency(lines: CommercialActionPreview["lineItems"]): string | null {
	const currencies = [...new Set(lines.map((line) => line.currency).filter(Boolean))];
	return currencies.length === 1 ? (currencies[0] ?? null) : null;
}

function commercialExecutionKey(previewToken: string, idempotencyKey: string): string {
	return `commercial:${sha256Hex(stableJson({ previewToken, idempotencyKey }))}`;
}

function requireCommercialRepository(
	repository: StripeBillingRepositoryDependency,
): Required<
	Pick<
		StripeBillingRepositoryDependency,
		| "createCommercialActionPreview"
		| "getCommercialActionPreview"
		| "beginCommercialActionExecution"
		| "completeCommercialActionExecution"
	>
> {
	if (
		repository.createCommercialActionPreview === undefined ||
		repository.getCommercialActionPreview === undefined ||
		repository.beginCommercialActionExecution === undefined ||
		repository.completeCommercialActionExecution === undefined
	) {
		throw new BillingError("Commercial previews are not configured", "STRIPE_NOT_CONFIGURED", 503);
	}
	return {
		createCommercialActionPreview: repository.createCommercialActionPreview.bind(repository),
		getCommercialActionPreview: repository.getCommercialActionPreview.bind(repository),
		beginCommercialActionExecution: repository.beginCommercialActionExecution.bind(repository),
		completeCommercialActionExecution:
			repository.completeCommercialActionExecution.bind(repository),
	};
}

function requireRecurringPlanRepository(
	repository: StripeBillingRepositoryDependency,
): NonNullable<StripeBillingRepositoryDependency["getStripeRecurringCheckoutPlanByKey"]> {
	if (repository.getStripeRecurringCheckoutPlanByKey === undefined) {
		throw new BillingError("Recurring pricing is not configured", "STRIPE_NOT_CONFIGURED", 503);
	}
	return repository.getStripeRecurringCheckoutPlanByKey.bind(repository);
}

function requireActiveBasePlanRepository(
	repository: StripeBillingRepositoryDependency,
): NonNullable<StripeBillingRepositoryDependency["hasActiveBasePlan"]> {
	if (repository.hasActiveBasePlan === undefined) {
		throw new BillingError("Recurring pricing is not configured", "STRIPE_NOT_CONFIGURED", 503);
	}
	return repository.hasActiveBasePlan.bind(repository);
}

function parseStripeEvent(event: unknown): ParsedStripeEvent {
	const rawEvent = requireRecord(event, "Stripe event");
	const id = requireNonBlankString(rawEvent.id, "Stripe event id");
	const type = requireNonBlankString(rawEvent.type, "Stripe event type");
	const data = requireRecord(rawEvent.data, "Stripe event data");

	return {
		id,
		type,
		created: safeEventCreated(rawEvent.created),
		object: requireRecord(data.object, "Stripe event object"),
	};
}

function stripeEventFromStoredEvent(event: StoreEventReplayJobRow): Record<string, unknown> {
	if (typeof event.raw_payload.type === "string" && isRecord(event.raw_payload.data)) {
		validateStoredFullStripeEvent(event);
		return event.raw_payload;
	}

	return {
		id: event.external_event_id ?? event.id,
		type: event.event_type,
		created: safeEventCreated(event.raw_payload.created),
		data: { object: event.raw_payload },
	};
}

function validateStoredFullStripeEvent(event: StoreEventReplayJobRow): void {
	const rawId = optionalNonBlankString(event.raw_payload.id);
	const rawType = optionalNonBlankString(event.raw_payload.type);

	if (rawType !== event.event_type) {
		throw new BillingError(
			"Stored Stripe event type does not match replay row",
			"INVALID_REQUEST",
			400,
		);
	}

	if (event.external_event_id !== null && rawId !== event.external_event_id) {
		throw new BillingError(
			"Stored Stripe event id does not match replay row",
			"INVALID_REQUEST",
			400,
		);
	}
}

function skippedEventTransactionId(event: ParsedStripeEvent): string | null {
	switch (event.type) {
		case "checkout.session.completed":
		case "checkout.session.async_payment_succeeded":
		case "checkout.session.expired":
		case "checkout.session.async_payment_failed":
			return (
				optionalId(event.object.payment_intent) ??
				optionalId(event.object.subscription) ??
				optionalId(event.object.id)
			);
		case "invoice.paid":
		case "invoice.payment_failed":
			return optionalId(event.object.id) ?? optionalId(event.object.subscription);
		case "customer.subscription.updated":
		case "customer.subscription.deleted":
		case "customer.subscription.trial_will_end":
			return optionalId(event.object.id);
		case "refund.created":
		case "refund.updated":
		case "charge.refunded":
		case "charge.dispute.created":
			return optionalId(event.object.id);
		default:
			return null;
	}
}

function skippedEventPurchaseKind(event: ParsedStripeEvent): PurchaseKind | null {
	switch (event.type) {
		case "checkout.session.completed":
		case "checkout.session.async_payment_succeeded":
			return optionalNonBlankString(event.object.mode) === "subscription"
				? "subscription"
				: "consumable";
		case "invoice.paid":
		case "invoice.payment_failed":
		case "customer.subscription.updated":
		case "customer.subscription.deleted":
		case "customer.subscription.trial_will_end":
			return "subscription";
		case "refund.created":
		case "refund.updated":
		case "charge.refunded":
		case "charge.dispute.created":
			return "consumable";
		default:
			return null;
	}
}

function invoiceReceipt(value: unknown): {
	status: string | null;
	total: number;
	amountPaid: number;
	currency: string;
	externalPaymentId: string | null;
} {
	const invoice = requireRecord(value, "Stripe invoice");
	const total = nonnegativeSafeInteger(invoice.total, "Stripe invoice total");
	const amountPaid = nonnegativeSafeInteger(invoice.amount_paid, "Stripe invoice amount paid");
	const currency = requireNonBlankString(invoice.currency, "Stripe invoice currency");
	return {
		status: optionalNonBlankString(invoice.status),
		total,
		amountPaid,
		currency,
		externalPaymentId: invoicePaymentId(invoice.payments),
	};
}

function invoicePaymentId(value: unknown): string | null {
	if (!isRecord(value) || !Array.isArray(value.data)) return null;
	for (const item of value.data) {
		if (!isRecord(item) || !isRecord(item.payment)) continue;
		const paymentIntent = optionalId(item.payment.payment_intent);
		if (paymentIntent !== null) return paymentIntent;
		const charge = optionalId(item.payment.charge);
		if (charge !== null) return charge;
		const paymentRecord = optionalId(item.payment.payment_record);
		if (paymentRecord !== null) return paymentRecord;
	}
	return null;
}

function stripePaymentActionRequired(error: unknown): boolean {
	if (!isRecord(error)) return false;
	const raw = isRecord(error.raw) ? error.raw : null;
	const code = optionalNonBlankString(error.code) ?? optionalNonBlankString(raw?.code);
	return new Set([
		"authentication_required",
		"invoice_payment_intent_requires_action",
		"payment_intent_action_required",
	]).has(code ?? "");
}

function stripeErrorPaymentIntentId(error: unknown): string | null {
	if (!isRecord(error)) return null;
	return (
		optionalId(error.payment_intent) ??
		(isRecord(error.raw) ? optionalId(error.raw.payment_intent) : null)
	);
}

function nonnegativeSafeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
	return value;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}

	return "Stripe event normalization failed";
}

function requireNonBlankString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new BillingError(`${name} is required`, "INVALID_REQUEST", 400);
	}

	return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new BillingError(`${name} is required`, "INVALID_REQUEST", 400);
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonBlankString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function optionalId(value: unknown): string | null {
	if (typeof value === "string" && value.trim() !== "") {
		return value;
	}

	if (!isRecord(value)) {
		return null;
	}

	const id = value.id;
	return typeof id === "string" && id.trim() !== "" ? id : null;
}

function parseOptionalIdempotencyKey(value: string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
		throw new BillingError("Idempotency-Key is invalid", "INVALID_IDEMPOTENCY_KEY", 400);
	}
	return value;
}

/** A plan's own trial applies unless the account already had a trial of that plan. */
function planTrialApplies(plan: StripeRecurringCheckoutPlan): boolean {
	return plan.trialDays !== null && plan.trialDays > 0 && !plan.trialUsed;
}

function planTrialSkipped(plan: StripeRecurringCheckoutPlan): boolean {
	return plan.trialDays !== null && plan.trialDays > 0 && plan.trialUsed;
}

function checkoutRequestHash(value: {
	billingAccountId: string;
	targetKey: string;
	targetKind: "product" | "plan";
	quantities: Record<string, number>;
	email: string | null;
	successUrl: string;
	cancelUrl: string;
	expiresAt?: number;
	discountCoupon?: string;
	promotionRedemptionId?: string;
	allowPromotionCodes?: boolean;
	trialSkipped?: boolean;
}): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Hosted setup keeps its own key namespace, so it never collides with a Checkout purchase. */
function stripePaymentSetupIdempotencyKey(projectKey: string, idempotencyKey: string): string {
	const digest = createHash("sha256").update(idempotencyKey).digest("hex");
	return `billing:payment-setup:${projectKey}:${digest}`;
}

/** The claim the replay worker already holds on the row, reused as the setup's claim identity. */
function workerIdOf(event: StoreEventReplayJobRow): string {
	return event.locked_by ?? `store-event:${event.id}`;
}

function paymentSetupWarnings(reusesExistingSetup: boolean): string[] {
	return reusesExistingSetup
		? ["An unfinished setup link already exists; executing returns that link unchanged."]
		: [];
}

function stripeCheckoutIdempotencyKey(projectKey: string, idempotencyKey: string): string {
	const digest = createHash("sha256").update(idempotencyKey).digest("hex");
	return `billing:checkout:${projectKey}:${digest}`;
}

function checkoutSessionResult(
	id: string,
	url: string,
	duplicate: boolean,
): StripeCheckoutSessionResult {
	return { sessionId: id, url, duplicate };
}

function defaultReturnOrigins(config: StripeBillingServiceConfig): string[] {
	return [
		...new Set(
			[config.checkoutSuccessUrl, config.checkoutCancelUrl, config.portalReturnUrl].map(
				(value) => new URL(value).origin,
			),
		),
	];
}

function checkoutStatus(value: string | null): "open" | "complete" | "expired" | "unknown" {
	return value === "open" || value === "complete" || value === "expired" ? value : "unknown";
}

function checkoutPaymentStatus(
	value: string | null,
): "paid" | "unpaid" | "no_payment_required" | "unknown" | null {
	if (value === null) {
		return null;
	}
	return value === "paid" || value === "unpaid" || value === "no_payment_required"
		? value
		: "unknown";
}

function isPaidCheckoutStatus(paymentStatus: ReturnType<typeof checkoutPaymentStatus>): boolean {
	return paymentStatus === "paid" || paymentStatus === "no_payment_required";
}

function paidCheckoutEmail(
	session: {
		customer_email?: string | null;
		customer_details?: { email?: string | null } | null;
	},
	paymentStatus: ReturnType<typeof checkoutPaymentStatus>,
): string | null {
	if (!isPaidCheckoutStatus(paymentStatus)) {
		return null;
	}

	const raw =
		optionalNonBlankString(session.customer_details?.email) ??
		optionalNonBlankString(session.customer_email);
	return raw === null ? null : raw.toLowerCase();
}

function paidCheckoutProductKey(
	session: { metadata: Stripe.Metadata | null },
	paymentStatus: ReturnType<typeof checkoutPaymentStatus>,
): string | null {
	if (!isPaidCheckoutStatus(paymentStatus)) {
		return null;
	}

	return optionalNonBlankString(session.metadata?.productKey);
}

function safeEventCreated(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
