import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
} from "./commercial";
import type { PaymentSetupSession } from "./payment-setup";
import type { WebCatalog } from "./web-catalog";

export interface WebCheckoutSessionStatus {
	sessionId: string;
	status: string | null;
	paymentStatus: string | null;
	customerEmail: string | null;
	productKey: string | null;
}

/** Shared hosted-billing port; each provider translates its own API shapes. */
export interface WebBillingService {
	expireCheckoutSession?(input: {
		billingAccountId: string;
		sessionId: string;
	}): Promise<WebCheckoutSessionStatus>;
	getCatalog?(): Promise<WebCatalog>;
	getBillingAccount?(billingAccountId: string): Promise<{
		schemaVersion: 1;
		customerExists: boolean;
		subscriptions: unknown[];
		recentInvoices: unknown[];
	}>;
	createCheckoutSession(input: {
		billingAccountId: string;
		productKey: string;
		email?: string | null;
		idempotencyKey?: string | null;
		successUrl?: string | null;
		cancelUrl?: string | null;
		expiresAt?: number;
	}): Promise<{
		sessionId: string;
		url: string;
		duplicate?: boolean;
	}>;
	createRecurringCheckoutSession?(input: {
		billingAccountId: string;
		planKey: string;
		quantities?: Record<string, number>;
		email?: string | null;
		idempotencyKey?: string | null;
		successUrl?: string | null;
		cancelUrl?: string | null;
		expiresAt?: number;
	}): Promise<{ sessionId: string; url: string; duplicate?: boolean }>;
	requestSubscriptionChange?(input: {
		billingAccountId: string;
		externalSubscriptionId: string;
		targetPlanKey: string;
		quantities: Record<string, number>;
		effectiveMode?: "immediate" | "period_end";
		prorationBehavior?: "always_invoice" | "create_prorations" | "none";
		idempotencyKey: string;
	}): Promise<unknown>;
	previewCommercialAction?(input: {
		billingAccountId: string;
		intent: CommercialActionIntent;
	}): Promise<CommercialActionPreview>;
	executeCommercialAction?(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
	}): Promise<CommercialActionExecutionResult>;
	getPaymentSetupSession?(input: {
		billingAccountId: string;
		sessionId: string;
	}): Promise<PaymentSetupSession>;
	createPortalSession(input: {
		billingAccountId: string;
		returnUrl?: string | null;
	}): Promise<{ url: string }>;
	getCheckoutSessionStatus(input: { billingAccountId: string; sessionId: string }): Promise<{
		sessionId: string;
		status: string | null;
		paymentStatus: string | null;
		customerEmail: string | null;
		productKey: string | null;
	}>;
	handleWebhook(input: { rawBody: string; signatureHeader: string | null }): Promise<unknown>;
}
