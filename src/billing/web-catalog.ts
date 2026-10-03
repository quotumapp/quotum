import type { BillingCadenceUnit } from "../shared/cadence";

export interface WebCatalog {
	schemaVersion: 1;
	plans: Array<{
		key: string;
		name: string;
		version: number;
		kind: "base" | "addon";
		tierRank: number;
		trialDays: number | null;
		trialRequiresPaymentMethod: boolean;
		trialEndBehavior: "cancel" | "pause";
		upgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
		downgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
		components: Array<{
			key: string;
			kind: "base" | "licensed" | "metered_overage";
			featureKey: string | null;
			featureUnit: string | null;
			includedQuantity: string | null;
			currency: string;
			unitAmountMinor: number;
			pricingModel: "flat" | "graduated" | "volume";
			tiers: Array<{
				upToQuantity: string | null;
				unitAmountMinor: number;
				flatAmountMinor: number;
			}>;
			billingUnits: string;
			interval: BillingCadenceUnit;
			intervalCount: number;
			minimumQuantity: number;
			maximumQuantity: number | null;
			taxBehavior: "inclusive" | "exclusive" | "unspecified";
		}>;
	}>;
	oneTimePurchases: Array<{
		key: string;
		name: string;
		kind: "topup" | "one_time";
		currency: string;
		amountMinor: number;
		credits: number;
	}>;
}
