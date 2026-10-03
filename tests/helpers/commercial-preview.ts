import type { StoredCommercialActionPreview } from "../../src/billing/commercial";

export function storedCommercialPreview(
	provider: "stripe" | "paddle" = "stripe",
): StoredCommercialActionPreview {
	return {
		intent: { kind: "checkout_product", productKey: "credits_100" },
		status: "previewed",
		executionIdempotencyKey: null,
		executionResult: null,
		preview: {
			schemaVersion: 1,
			previewToken: "11111111-1111-4111-8111-111111111111",
			expiresAt: "2099-01-01T00:00:00.000Z",
			billingAccountId: "user_1",
			provider,
			action: "checkout_product",
			intentHash: "a".repeat(64),
			stateFingerprint: "b".repeat(64),
			lineItems: [],
			estimatedTotalMinor: null,
			subtotalMinor: 1000,
			discountTotalMinor: 0,
			currency: "USD",
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
			toPlanVersionId: null,
			targetId: "product",
			warnings: [],
		},
	};
}
