import type { ProjectInstanceContext } from "../projects/context";
import type { BillingProvider } from "./types";

/**
 * One provider and currency of an affiliate's revenue. `estimated` marks a catalog price counted
 * once per payment, the only figure available for App Store and Google Play purchases. Payments
 * whose product has no price report a count with a null `currency` and `amountMinor`.
 */
export interface AffiliateRevenue {
	provider: BillingProvider;
	currency: string | null;
	payments: number;
	amountMinor: number | null;
	estimated: boolean;
}

export interface AffiliateSummary {
	affiliateKey: string;
	customers: number;
	revenue: AffiliateRevenue[];
}

export interface AffiliateCustomer {
	billingAccountId: string;
	affiliateKeySetAt: string;
}

export interface AffiliateCustomerPage {
	items: AffiliateCustomer[];
	nextCursor: string | null;
}

export interface AffiliateServiceLike {
	/** Keeps the account's first key: a later key changes nothing and never fails the purchase. */
	recordAffiliateKey(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; affiliateKey: string },
	): Promise<void>;
	getAffiliateSummary(
		project: ProjectInstanceContext,
		affiliateKey: string,
	): Promise<AffiliateSummary>;
	listAffiliateCustomers(
		project: ProjectInstanceContext,
		affiliateKey: string,
		input: { limit: number; cursor: string | null },
	): Promise<AffiliateCustomerPage>;
}
