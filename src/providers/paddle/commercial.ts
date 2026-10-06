import type { CommercialActionIntent, CommercialPreviewDraft } from "../../billing/commercial";
import { sha256Hex, stableJson } from "../../billing/decimal";
import { BillingError } from "../../billing/errors";
import type { ProjectScopedBillingRepository } from "../../db/repository";
import type { RuntimeConnectionConfigs } from "../../projects/connections";
import type { PaddlePriceBinding } from "./catalog";
import { paddleResumableKeys } from "./customer-operation";
import type { PaddleGateway } from "./gateway";
import { normalizePaddleEmail, type PaddlePlanPin, parsePaddleCommercialContext } from "./plan";

type Checkout = Extract<CommercialActionIntent, { kind: "checkout_plan" | "checkout_product" }>;
type Writer = (
	input: {
		billingAccountId: string;
		email?: string | null;
		idempotencyKey: string;
		previewToken: string;
	},
	binding: PaddlePriceBinding,
	plan?: PaddlePlanPin,
) => Promise<{ sessionId: string; url: string; duplicate: boolean }>;

/** A preview makes reads only. Execution binds one key before any customer or transaction write. */
export class PaddleCommercial {
	constructor(
		private readonly repository: ProjectScopedBillingRepository,
		private readonly gateway: PaddleGateway,
		private readonly config: RuntimeConnectionConfigs["paddle"],
		private readonly write: Writer,
	) {}

	async preview(input: { billingAccountId: string; intent: CommercialActionIntent }) {
		// A preview resumes nothing: what a dead request left before dispatching is released.
		await this.releaseNeverSent(input.billingAccountId, []);
		return this.repository.createCommercialActionPreview(
			await this.draft(input.billingAccountId, input.intent),
		);
	}

	async execute(input: { billingAccountId: string; previewToken: string; idempotencyKey: string }) {
		let stored = await this.repository.getCommercialActionPreview(
			input.billingAccountId,
			input.previewToken,
		);
		if (stored.preview.provider !== "paddle")
			throw new BillingError(
				"Preview belongs to another provider",
				"COMMERCIAL_PREVIEW_MISMATCH",
				409,
			);
		if (
			stored.executionIdempotencyKey !== null &&
			stored.executionIdempotencyKey !== input.idempotencyKey
		)
			throw new BillingError("Execution is bound to another key", "IDEMPOTENCY_CONFLICT", 409);
		if (stored.status === "executed" && stored.executionResult) return stored.executionResult;
		const context = parsePaddleCommercialContext(stored.providerContext);
		if (
			context.connectionVersionId !== this.config.versionId ||
			context.providerAccountId !== this.config.accountIdentity ||
			context.paymentPageUrl !== this.config.paymentPageUrl
		)
			throw new BillingError(
				"Recorded Paddle connection is unavailable",
				"COMMERCIAL_PREVIEW_STALE",
				409,
			);
		// Short, deterministic and disjoint from direct checkout keys. A retry uses the same intent.
		const executionKey = `commercial:${input.previewToken}`;
		await this.releaseNeverSent(
			input.billingAccountId,
			paddleResumableKeys(input.billingAccountId, executionKey),
		);
		if (stored.status === "previewed") {
			const current = await this.draft(input.billingAccountId, stored.intent, true);
			stored = await this.repository.beginCommercialActionExecution({
				...input,
				intentHash: current.intentHash,
				stateFingerprint: current.stateFingerprint,
			});
			if (stored.status === "executed" && stored.executionResult) return stored.executionResult;
		}
		const intent = normalize(stored.intent);
		const checkoutInput = {
			billingAccountId: input.billingAccountId,
			email: intent.email,
			idempotencyKey: executionKey,
			previewToken: input.previewToken,
		};
		let checkout: Awaited<ReturnType<Writer>>;
		try {
			checkout = await this.write(
				checkoutInput,
				context.target.binding,
				context.target.plan ?? undefined,
			);
		} catch (error) {
			await this.repository.rejectUnboundPaddleCheckout(checkoutInput);
			throw error;
		}
		return this.repository.completeCommercialActionExecution({
			...input,
			result: { kind: "checkout", ...checkout },
		});
	}

	private releaseNeverSent(billingAccountId: string, resumableKeys: readonly string[]) {
		return this.repository.releaseNeverSentPaddleCheckout({
			billingAccountId,
			connectionVersionId: this.config.versionId,
			resumableKeys,
		});
	}

	private async draft(
		billingAccountId: string,
		raw: CommercialActionIntent,
		executing = false,
	): Promise<CommercialPreviewDraft> {
		const intent = normalize(raw);
		const target =
			intent.kind === "checkout_plan"
				? await this.repository.getPaddlePlan(billingAccountId, intent.planKey)
				: await this.repository.getPaddleProduct(intent.productKey);
		if (
			intent.kind === "checkout_plan" &&
			Object.entries(intent.quantities).some(
				([key, value]) => key !== target.priceKey || value !== 1,
			)
		)
			unsupported();
		if (intent.kind === "checkout_plan") intent.quantities = {};
		const hasActiveBasePlan = await this.repository.hasActiveBasePlan(billingAccountId);
		if (hasActiveBasePlan && !executing)
			throw new BillingError("A base plan is already active", "BASE_PLAN_ALREADY_ACTIVE", 409);
		const customerId = await this.repository.getPaddleCustomer(
			billingAccountId,
			this.config.accountIdentity,
		);
		if (!intent.email && !customerId)
			throw new BillingError(
				"Email is required to create the Paddle customer",
				"PADDLE_CUSTOMER_EMAIL_REQUIRED",
				400,
			);
		if (!customerId)
			await this.repository.assertPaddleCustomerIntent(
				billingAccountId,
				this.config.accountIdentity,
				intent.email ?? null,
				null,
			);
		await this.gateway.validatePrices([target.binding], true);
		const context = {
			connectionVersionId: this.config.versionId,
			providerAccountId: this.config.accountIdentity,
			paymentPageUrl: this.config.paymentPageUrl,
			target,
		};
		const intentHash = sha256Hex(stableJson({ provider: "paddle", billingAccountId, intent }));
		const stateFingerprint = sha256Hex(stableJson({ context, hasActiveBasePlan, customerId }));
		const binding = target.binding;
		return {
			billingAccountId,
			intent,
			intentHash,
			stateFingerprint,
			providerContext: context,
			preview: {
				schemaVersion: 1,
				billingAccountId,
				intentHash,
				stateFingerprint,
				provider: "paddle",
				action: intent.kind,
				lineItems: [
					{
						key: target.priceKey,
						label: target.name,
						quantity: 1,
						unitAmountMinor: Number(binding.unitAmountMinor),
						currency: binding.currency,
						interval: binding.billingCycle?.interval ?? null,
						intervalCount: binding.billingCycle?.frequency ?? null,
						pricingModel: "flat",
						subtotalMinor: Number(binding.unitAmountMinor),
						discountMinor: 0,
						totalMinor: null,
					},
				],
				estimatedTotalMinor: null,
				subtotalMinor: Number(binding.unitAmountMinor),
				discountTotalMinor: 0,
				currency: binding.currency,
				amountStatus: "provider_calculated",
				promotionCodeEntry: "none",
				promotion: null,
				nextCycle: null,
				cancellation: null,
				paymentSetup: null,
				carryOver: null,
				effectiveMode: null,
				effectiveAt: null,
				prorationBehavior: null,
				changeKind: null,
				fromPlanVersionId: null,
				toPlanVersionId: target.plan?.planVersionId ?? null,
				targetId: target.plan?.planVersionId ?? target.storeProductId,
				warnings: [
					"Paddle calculates the final total and tax at checkout. Access starts after verified provider events.",
				],
			},
		};
	}
}

function normalize(raw: CommercialActionIntent): Checkout {
	if (raw.kind !== "checkout_plan" && raw.kind !== "checkout_product") unsupported();
	if (
		raw.successUrl ||
		raw.cancelUrl ||
		raw.expiresAt !== undefined ||
		raw.promotionCode ||
		raw.allowPromotionCodes
	)
		unsupported();
	const email = normalizePaddleEmail(raw.email);
	return raw.kind === "checkout_plan"
		? { kind: raw.kind, planKey: raw.planKey.trim(), quantities: { ...raw.quantities }, email }
		: { kind: raw.kind, productKey: raw.productKey.trim(), email };
}
function unsupported(): never {
	throw new BillingError(
		"Paddle commercial checkout supports fixed subscriptions at quantity one and the configured payment page only",
		"PADDLE_OPERATION_UNSUPPORTED",
		400,
	);
}
