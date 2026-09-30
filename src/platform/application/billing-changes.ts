import type { MerchantCapability } from "../contracts";

export interface BillingChangeInput {
	action: string;
	parameters: string[];
	body: unknown;
}
export interface BillingChangeDescriptor {
	action: string;
	capability: MerchantCapability;
	stepUpAction: "catalog.publish" | "operations.write" | "operations.recover";
	alwaysSensitive: boolean;
}
export interface BillingChangePreview {
	input: BillingChangeInput;
	before: unknown;
	after: unknown;
	fingerprint: string;
	previewToken?: string;
	expiresAt?: string;
}
export interface BillingChangeContext {
	projectInstanceId: string;
	actor: string;
}
export interface BillingChangesPort {
	actions: readonly BillingChangeDescriptor[];
	inspect(
		context: BillingChangeContext,
		input: { resource: string; parameters: string[]; query: Record<string, string> },
	): Promise<unknown>;
	prepare(context: BillingChangeContext, input: BillingChangeInput): Promise<BillingChangePreview>;
	apply(
		context: BillingChangeContext,
		preview: BillingChangePreview,
		key: string,
	): Promise<{ status: number; body: unknown }>;
	recover(
		context: BillingChangeContext,
		key: string,
	): Promise<{ status: number; body: unknown } | null>;
}
