import type { AuthoredCatalogIntent } from "../../../src/catalog/types";
import type { BillingRepository } from "../../../src/db/repository";
import type { ProjectInstanceContext } from "../../../src/projects/context";
import { integrationProjectContext } from "./platform-fixture";
export const aiCreditsCatalog: AuthoredCatalogIntent = {
	features: [
		{
			key: "ai_credits",
			name: "AI credits",
			kind: "metered",
			meterKind: "consumable",
			unit: "credit",
			creditScale: 3,
			filterDimensions: [],
		},
		{
			key: "model_tokens",
			name: "Model tokens",
			kind: "metered",
			meterKind: "consumable",
			unit: "token",
			creditScale: 0,
			filterDimensions: ["model"],
		},
	],
	plans: [
		{
			key: "premium",
			name: "Premium",
			version: 1,
			trialDays: null,
			items: [
				{
					featureKey: "ai_credits",
					itemKind: "allocation",
					quantity: "1000",
					reset: {
						interval: "month",
						intervalCount: 1,
					},
				},
			],
			providerPriced: {
				billingInterval: "month",
				providerBindings: [
					{ productKey: "premium_monthly", provider: "apple", channel: "ios" },
					{ productKey: "premium_monthly", provider: "google", channel: "android" },
					{ productKey: "premium_monthly", provider: "stripe", channel: "web" },
				],
			},
		},
	],
	topups: [
		{
			key: "ai_credits_10",
			featureKey: "ai_credits",
			quantity: "10",
			providerBindings: [
				{ productKey: "echo_credits_10", provider: "apple", channel: "ios" },
				{ productKey: "echo_credits_10", provider: "google", channel: "android" },
				{ productKey: "echo_credits_10", provider: "stripe", channel: "web" },
			],
			expiry: {
				mode: "after_seconds",
				seconds: 315360000,
			},
		},
	],
	rateCards: [
		{
			meterFeatureKey: "model_tokens",
			walletFeatureKey: "ai_credits",
			ratePerUnit: "0.005",
		},
	],
};

export async function publishAiCreditsCatalog(
	repository: BillingRepository,
	projectKey: string | ProjectInstanceContext = "acme",
): Promise<void> {
	const project =
		typeof projectKey === "string" ? integrationProjectContext(projectKey) : projectKey;
	const preview = await repository.previewCatalog(project, {
		expectedRevision: null,
		actor: "integration-catalog-fixture",
		catalog: aiCreditsCatalog,
	});
	await repository.publishCatalog(project, {
		expectedRevision: null,
		actor: "integration-catalog-fixture",
		previewToken: preview.previewToken,
		catalog: aiCreditsCatalog,
	});
}
