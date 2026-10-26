import {
	type CommercialActionExecutionResult,
	type CommercialActionIntent,
	refuseEmbeddedCheckout,
	refuseRefund,
	type StoredCommercialActionPreview,
	storedExecutionAnswer,
} from "../billing/commercial";
import { BillingError, NotConfiguredError } from "../billing/errors";
import type { WebBillingService } from "../billing/web-provider";
import type { ProjectInstanceContext } from "../projects/context";
import { parsePaddleCommercialContext } from "../providers/paddle/plan";
import type { PreviewOptions } from "../shared/preview-lifetime";
import type { ProjectProviderServiceResolver } from "./types";

export interface CommercialPreviewReader {
	getCommercialActionPreview(
		project: ProjectInstanceContext,
		billingAccountId: string,
		previewToken: string,
	): Promise<StoredCommercialActionPreview>;
}
type Routing = {
	project: ProjectInstanceContext;
	services: ProjectProviderServiceResolver;
	billingAccountId: string;
};

async function service(
	input: Routing,
	provider: "stripe" | "paddle",
	stored?: StoredCommercialActionPreview,
): Promise<WebBillingService> {
	const version = stored?.providerContext?.connectionVersionId;
	const resolved =
		provider === "stripe"
			? await input.services.stripeBillingService(input.project)
			: stored && stored.status !== "previewed"
				? typeof version === "string"
					? await input.services.paddleBillingServiceVersion?.(input.project, version)
					: null
				: await input.services.paddleBillingService?.(input.project);
	if (!resolved)
		throw new NotConfiguredError(
			`${provider} commercial connection is unavailable`,
			"BILLING_PROVIDER_NOT_CONFIGURED",
			503,
		);
	return resolved;
}

export async function previewCommercial(
	input: Routing & {
		provider: "stripe" | "paddle";
		intent: CommercialActionIntent;
		previewOptions?: PreviewOptions;
	},
) {
	const selected = await service(input, input.provider);
	if (!selected.previewCommercialAction)
		throw new NotConfiguredError("Commercial previews are not available", undefined, 503, {
			provider: input.provider,
			adapterMethod: "commercial.preview",
		});
	return selected.previewCommercialAction({
		billingAccountId: input.billingAccountId,
		intent: input.intent,
		previewOptions: input.previewOptions,
	});
}

/** Execution selects the account-scoped persisted provider, never a second caller choice. */
export async function executeCommercial(
	input: Routing & {
		reader: CommercialPreviewReader;
		previewToken: string;
		idempotencyKey: string;
		/**
		 * The console and MCP change proposals, which store what they answer and show a person a
		 * summary of the preview: they refuse an embedded Checkout (a client secret) and a refund.
		 */
		merchantCaller?: boolean;
	},
): Promise<CommercialActionExecutionResult> {
	const stored = await input.reader.getCommercialActionPreview(
		input.project,
		input.billingAccountId,
		input.previewToken,
	);
	if (input.merchantCaller === true) {
		refuseEmbeddedCheckout(stored.intent);
		refuseRefund(stored.intent);
	}
	if (
		stored.executionIdempotencyKey !== null &&
		stored.executionIdempotencyKey !== input.idempotencyKey
	)
		throw new BillingError(
			"Commercial execution is bound to another key",
			"IDEMPOTENCY_CONFLICT",
			409,
		);
	if (stored.status === "executed" && stored.executionResult) {
		// An embedded Checkout stores no client secret, so its provider answers the replay.
		const answer = storedExecutionAnswer(stored.executionResult);
		if (answer !== null) return answer;
	}
	const provider = stored.preview.provider;
	if (provider === "paddle") parsePaddleCommercialContext(stored.providerContext);
	if (provider !== "stripe" && provider !== "paddle")
		throw new NotConfiguredError("Commercial provider is unavailable");
	const selected = await service(input, provider, stored);
	if (!selected.executeCommercialAction)
		throw new NotConfiguredError("Commercial actions are not available", undefined, 503, {
			provider,
			adapterMethod: "commercial.execute",
		});
	return selected.executeCommercialAction({
		billingAccountId: input.billingAccountId,
		previewToken: input.previewToken,
		idempotencyKey: input.idempotencyKey,
	});
}
