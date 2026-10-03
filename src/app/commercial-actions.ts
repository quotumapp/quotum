import type { CommercialActionIntent, StoredCommercialActionPreview } from "../billing/commercial";
import { BillingError, NotConfiguredError } from "../billing/errors";
import type { WebBillingService } from "../billing/web-provider";
import type { ProjectInstanceContext } from "../projects/context";
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
	input: Routing & { provider: "stripe" | "paddle"; intent: CommercialActionIntent },
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
	});
}

/** Execution selects the account-scoped persisted provider, never a second caller choice. */
export async function executeCommercial(
	input: Routing & {
		reader: CommercialPreviewReader;
		previewToken: string;
		idempotencyKey: string;
	},
) {
	const stored = await input.reader.getCommercialActionPreview(
		input.project,
		input.billingAccountId,
		input.previewToken,
	);
	if (
		stored.executionIdempotencyKey !== null &&
		stored.executionIdempotencyKey !== input.idempotencyKey
	)
		throw new BillingError(
			"Commercial execution is bound to another key",
			"IDEMPOTENCY_CONFLICT",
			409,
		);
	if (stored.status === "executed" && stored.executionResult) return stored.executionResult;
	const provider = stored.preview.provider;
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
