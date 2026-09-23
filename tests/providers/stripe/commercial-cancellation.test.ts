import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
	CommercialPreviewDraft,
	StoredCommercialActionPreview,
} from "../../../src/billing/commercial";
import { sha256Hex, stableJson } from "../../../src/billing/decimal";
import type { SubscriptionCancellationContext } from "../../../src/billing/recurring";
import { type SubscriptionStatus, subscriptionStatuses } from "../../../src/billing/types";
import { stripeCapabilities } from "../../../src/providers/stripe/capabilities";
import {
	StripeBillingService,
	type StripeBillingServiceDependencies,
} from "../../../src/providers/stripe/service";
import { evaluateCapability } from "../../../src/shared/provider-capabilities";

type Repository = StripeBillingServiceDependencies["repository"];
type Client = StripeBillingServiceDependencies["client"];

const billingAccountId = "user_1";
const previewToken = "11111111-1111-4111-8111-111111111111";
const periodEnd = "2026-10-17T00:00:00.000Z";

function context(
	overrides: Partial<SubscriptionCancellationContext> = {},
): SubscriptionCancellationContext {
	return {
		customerId: "customer-1",
		externalSubscriptionId: "sub_123",
		status: "active",
		planKind: "base",
		planVersionId: "42",
		cancelAtPeriodEnd: false,
		currentPeriodEnd: periodEnd,
		pendingChange: null,
		activeAddOnSubscriptionIds: [],
		postpaidUsageSettlesAt: null,
		stateFingerprint: "c".repeat(64),
		...overrides,
	};
}

interface Call {
	method: string;
	[key: string]: unknown;
}

function cancellationService(subscription: SubscriptionCancellationContext) {
	const calls: Call[] = [];
	let stored: StoredCommercialActionPreview | null = null;
	const client: Partial<Client> = {
		cancelSubscription(subscriptionId, idempotencyKey) {
			calls.push({ method: "cancelSubscription", subscriptionId, idempotencyKey });
			return Promise.resolve({ id: subscriptionId });
		},
		updateSubscription(subscriptionId, params, idempotencyKey) {
			calls.push({ method: "updateSubscription", subscriptionId, params, idempotencyKey });
			return Promise.resolve({ id: subscriptionId });
		},
	};
	const repository: Partial<Repository> = {
		previewSubscriptionCancellation(input) {
			calls.push({ method: "previewSubscriptionCancellation", ...input });
			return Promise.resolve(subscription);
		},
		createCommercialActionPreview(draft: CommercialPreviewDraft) {
			const preview: CommercialActionPreview = {
				...draft.preview,
				previewToken,
				expiresAt: "2026-09-22T00:15:00.000Z",
			};
			stored = {
				intent: draft.intent,
				preview,
				status: "previewed",
				executionIdempotencyKey: null,
				executionResult: null,
			};
			return Promise.resolve(preview);
		},
		getCommercialActionPreview() {
			if (stored === null) throw new Error("No preview was created");
			return Promise.resolve(stored);
		},
		beginCommercialActionExecution() {
			if (stored === null) throw new Error("No preview was created");
			return Promise.resolve({ ...stored, status: "executing" as const });
		},
		completeCommercialActionExecution() {
			throw new Error("A cancellation completes through completeSubscriptionCancellation");
		},
		completeSubscriptionCancellation(input) {
			calls.push({ method: "completeSubscriptionCancellation", ...input });
			return Promise.resolve({
				...input.result,
				supersededChangeId: input.supersedesPendingChange ? "change-1" : null,
			});
		},
	};
	const service = new StripeBillingService({
		config: {
			checkoutSuccessUrl: "https://app.example.com/billing/success",
			checkoutCancelUrl: "https://app.example.com/billing",
			portalReturnUrl: "https://app.example.com/account/billing",
		},
		client: client as Client,
		repository: repository as Repository,
	});
	return { service, calls };
}

async function run(
	subscription: SubscriptionCancellationContext,
	intent: CommercialActionIntent,
): Promise<{ preview: CommercialActionPreview; calls: Call[]; service: StripeBillingService }> {
	const { service, calls } = cancellationService(subscription);
	const preview = await service.previewCommercialAction({ billingAccountId, intent });
	return { preview, calls, service };
}

/** The recorded end of access, which only a cancellation result carries. */
function executedAt(result: CommercialActionExecutionResult): string | null {
	return result.kind === "subscription_cancellation" ? result.effectiveAt : null;
}

const executionKey = (idempotencyKey: string) =>
	`billing:subscription-cancel:commercial:${sha256Hex(stableJson({ previewToken, idempotencyKey }))}`;

describe("commercial cancellation previews", () => {
	// capability: subscription.cancel
	it("previews an immediate cancellation as ending access now and keeping granted allocations", async () => {
		const before = Date.now();
		const { preview } = await run(context({ postpaidUsageSettlesAt: periodEnd }), {
			kind: "cancel",
			externalSubscriptionId: "sub_123",
			effectiveMode: "immediate",
		});

		expect(preview).toMatchObject({
			action: "cancel",
			provider: "stripe",
			lineItems: [],
			estimatedTotalMinor: 0,
			amountStatus: "exact",
			currency: null,
			promotionCodeEntry: "none",
			effectiveMode: "immediate",
			prorationBehavior: "none",
			changeKind: null,
			fromPlanVersionId: "42",
			toPlanVersionId: null,
			targetId: "sub_123",
		});
		expect(preview.cancellation).toEqual({
			action: "cancel",
			accessEndsAt: preview.effectiveAt as string,
			cancelAtPeriodEnd: false,
			keepsGrantedAllocations: true,
			postpaidUsageSettlesAt: periodEnd,
			supersedesChangeId: null,
			activeAddOnSubscriptionIds: [],
		});
		expect(Date.parse(preview.effectiveAt as string)).toBeGreaterThanOrEqual(before);
		expect(preview.warnings).toEqual([
			"Plan allocations already granted for the paid period stay spendable until their own expiry.",
			`Postpaid usage in the open period is not accelerated; it settles at ${periodEnd}.`,
		]);
	});

	// capability: subscription.cancel
	it("previews a period-end cancellation as ending access at the period end", async () => {
		const { preview } = await run(context(), {
			kind: "cancel",
			externalSubscriptionId: "sub_123",
			effectiveMode: "period_end",
		});

		expect(preview.action).toBe("cancel");
		expect(preview.effectiveAt).toBe(periodEnd);
		expect(preview.cancellation).toMatchObject({
			action: "cancel",
			accessEndsAt: periodEnd,
			cancelAtPeriodEnd: true,
		});
	});

	// capability: subscription.cancel
	it("previews a period-end cancellation that already holds as nothing to do", async () => {
		const { preview } = await run(context({ cancelAtPeriodEnd: true }), {
			kind: "cancel",
			externalSubscriptionId: "sub_123",
			effectiveMode: "period_end",
		});

		expect(preview.action).toBe("none");
		expect(preview.cancellation).toMatchObject({
			action: "none",
			accessEndsAt: periodEnd,
			cancelAtPeriodEnd: true,
			supersedesChangeId: null,
		});
		expect(preview.warnings).toEqual([]);
	});

	// capability: subscription.uncancel
	it("previews an uncancellation only while one is pending", async () => {
		const pending = await run(context({ cancelAtPeriodEnd: true }), {
			kind: "uncancel",
			externalSubscriptionId: "sub_123",
		});
		const nothingPending = await run(context(), {
			kind: "uncancel",
			externalSubscriptionId: "sub_123",
		});

		expect(pending.preview.action).toBe("uncancel");
		expect(pending.preview.effectiveMode).toBeNull();
		expect(pending.preview.cancellation).toMatchObject({
			action: "uncancel",
			accessEndsAt: null,
			cancelAtPeriodEnd: false,
		});
		expect(pending.preview.warnings).toEqual([
			"Uncancelling does not restore a subscription change the cancellation superseded.",
		]);
		expect(nothingPending.preview.action).toBe("none");
		expect(nothingPending.preview.cancellation).toMatchObject({ action: "none" });
	});

	// capability: subscription.cancel
	it("reports the queued change a cancellation would supersede", async () => {
		const { preview } = await run(
			context({ pendingChange: { id: "change-1", status: "pending" } }),
			{ kind: "cancel", externalSubscriptionId: "sub_123", effectiveMode: "immediate" },
		);

		expect(preview.cancellation?.supersedesChangeId).toBe("change-1");
		expect(preview.warnings).toContain("Subscription change change-1 will be cancelled.");
	});

	// capability: subscription.cancel
	it("refuses a subscription that has already ended", async () => {
		await expect(
			run(context({ status: "expired" }), {
				kind: "cancel",
				externalSubscriptionId: "sub_123",
				effectiveMode: "immediate",
			}),
		).rejects.toMatchObject({
			code: "SUBSCRIPTION_NOT_CANCELLABLE",
			status: 409,
			details: { subscriptionStatus: "expired" },
		});
	});

	// capability: subscription.uncancel
	it("refuses to uncancel a subscription Stripe already ended", async () => {
		await expect(
			run(context({ status: "cancelled", cancelAtPeriodEnd: true }), {
				kind: "uncancel",
				externalSubscriptionId: "sub_123",
			}),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_NOT_CANCELLABLE", status: 409 });
	});

	// capability: subscription.cancel
	it("refuses a base plan while add-on subscriptions are active, and names them", async () => {
		await expect(
			run(context({ activeAddOnSubscriptionIds: ["sub_addon_a", "sub_addon_b"] }), {
				kind: "cancel",
				externalSubscriptionId: "sub_123",
				effectiveMode: "immediate",
			}),
		).rejects.toMatchObject({
			code: "ADDON_SUBSCRIPTIONS_ACTIVE",
			status: 409,
			details: { addOnSubscriptionIds: ["sub_addon_a", "sub_addon_b"] },
		});
	});

	// capability: subscription.cancel
	it("cancels an add-on itself while other add-ons are active", async () => {
		const { preview } = await run(
			context({ planKind: "addon", activeAddOnSubscriptionIds: ["sub_addon_b"] }),
			{ kind: "cancel", externalSubscriptionId: "sub_123", effectiveMode: "immediate" },
		);

		expect(preview.action).toBe("cancel");
		expect(preview.cancellation?.activeAddOnSubscriptionIds).toEqual(["sub_addon_b"]);
	});

	// capability: subscription.cancel
	it("refuses a cancellation while a worker is applying a change", async () => {
		await expect(
			run(context({ pendingChange: { id: "change-1", status: "processing" } }), {
				kind: "cancel",
				externalSubscriptionId: "sub_123",
				effectiveMode: "immediate",
			}),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_PENDING", status: 409 });
	});

	// capability: subscription.cancel
	it("refuses a period-end cancellation without a known period end", async () => {
		await expect(
			run(context({ currentPeriodEnd: null }), {
				kind: "cancel",
				externalSubscriptionId: "sub_123",
				effectiveMode: "period_end",
			}),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_PERIOD_MISSING", status: 409 });
	});
});

describe("commercial cancellation execution", () => {
	// capability: subscription.cancel
	it("ends the Stripe subscription at once and supersedes its queued change", async () => {
		const { service, calls } = cancellationService(
			context({
				pendingChange: { id: "change-1", status: "pending" },
				postpaidUsageSettlesAt: periodEnd,
			}),
		);
		const preview = await service.previewCommercialAction({
			billingAccountId,
			intent: { kind: "cancel", externalSubscriptionId: "sub_123", effectiveMode: "immediate" },
		});
		const result = await service.executeCommercialAction({
			billingAccountId,
			previewToken: preview.previewToken,
			idempotencyKey: "cancel-1",
		});

		const endedAt = executedAt(result);
		expect(Object.keys(result).sort()).toEqual([
			"action",
			"cancelAtPeriodEnd",
			"effectiveAt",
			"effectiveMode",
			"externalSubscriptionId",
			"kind",
			"supersededChangeId",
		]);
		expect(result).toMatchObject({
			kind: "subscription_cancellation",
			action: "cancel",
			externalSubscriptionId: "sub_123",
			effectiveMode: "immediate",
			cancelAtPeriodEnd: false,
			supersededChangeId: "change-1",
		});
		// Execution resolves the intent again, so an immediate cancellation records when access
		// actually ended rather than replaying the moment the preview was taken.
		expect(Date.parse(endedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(preview.effectiveAt ?? ""));
		expect(calls.filter((call) => call.method === "cancelSubscription")).toEqual([
			{
				method: "cancelSubscription",
				subscriptionId: "sub_123",
				idempotencyKey: executionKey("cancel-1"),
			},
		]);
		expect(calls.some((call) => call.method === "updateSubscription")).toBe(false);
		expect(calls.at(-1)).toMatchObject({
			method: "completeSubscriptionCancellation",
			externalSubscriptionId: "sub_123",
			supersedesPendingChange: true,
			idempotencyKey: "cancel-1",
		});
	});

	// capability: subscription.cancel
	it("sets cancel_at_period_end for a period-end cancellation", async () => {
		const { service, calls } = cancellationService(context());
		const preview = await service.previewCommercialAction({
			billingAccountId,
			intent: { kind: "cancel", externalSubscriptionId: "sub_123", effectiveMode: "period_end" },
		});
		const result = await service.executeCommercialAction({
			billingAccountId,
			previewToken: preview.previewToken,
			idempotencyKey: "cancel-2",
		});

		expect(result).toMatchObject({
			kind: "subscription_cancellation",
			action: "cancel",
			effectiveMode: "period_end",
			effectiveAt: periodEnd,
			cancelAtPeriodEnd: true,
			supersededChangeId: null,
		});
		expect(calls.filter((call) => call.method === "updateSubscription")).toEqual([
			{
				method: "updateSubscription",
				subscriptionId: "sub_123",
				params: { cancel_at_period_end: true },
				idempotencyKey: executionKey("cancel-2"),
			},
		]);
	});

	// capability: subscription.uncancel
	it("clears cancel_at_period_end without superseding anything", async () => {
		const { service, calls } = cancellationService(
			context({ cancelAtPeriodEnd: true, pendingChange: { id: "change-1", status: "pending" } }),
		);
		const preview = await service.previewCommercialAction({
			billingAccountId,
			intent: { kind: "uncancel", externalSubscriptionId: "sub_123" },
		});
		const result = await service.executeCommercialAction({
			billingAccountId,
			previewToken: preview.previewToken,
			idempotencyKey: "uncancel-1",
		});

		expect(result).toMatchObject({
			kind: "subscription_cancellation",
			action: "uncancel",
			effectiveMode: null,
			effectiveAt: null,
			cancelAtPeriodEnd: false,
			supersededChangeId: null,
		});
		expect(calls.filter((call) => call.method === "updateSubscription")).toEqual([
			{
				method: "updateSubscription",
				subscriptionId: "sub_123",
				params: { cancel_at_period_end: false },
				idempotencyKey: executionKey("uncancel-1"),
			},
		]);
		expect(calls.at(-1)).toMatchObject({ supersedesPendingChange: false });
	});

	// capability: subscription.uncancel
	it("calls no provider for an execution with nothing to do", async () => {
		const { service, calls } = cancellationService(context());
		const preview = await service.previewCommercialAction({
			billingAccountId,
			intent: { kind: "uncancel", externalSubscriptionId: "sub_123" },
		});
		const result = await service.executeCommercialAction({
			billingAccountId,
			previewToken: preview.previewToken,
			idempotencyKey: "uncancel-2",
		});

		expect(result).toMatchObject({ kind: "subscription_cancellation", action: "none" });
		expect(calls.map((call) => call.method)).not.toContain("cancelSubscription");
		expect(calls.map((call) => call.method)).not.toContain("updateSubscription");
		expect(calls.at(-1)).toMatchObject({ supersedesPendingChange: false });
	});
});

type CancellationRequest = "cancel-immediate" | "cancel-period_end" | "uncancel";
type PendingChangeStatus = "pending" | "processing" | null;

const cancellationRequests: CancellationRequest[] = [
	"cancel-immediate",
	"cancel-period_end",
	"uncancel",
];
const pendingChangeStatuses: PendingChangeStatus[] = [null, "pending", "processing"];

function cancellationIntent(request: CancellationRequest): CommercialActionIntent {
	return request === "uncancel"
		? { kind: "uncancel", externalSubscriptionId: "sub_123" }
		: {
				kind: "cancel",
				externalSubscriptionId: "sub_123",
				effectiveMode: request === "cancel-immediate" ? "immediate" : "period_end",
			};
}

/** Previews and executes the request against one subscription state; null when neither refuses. */
async function refusal(
	subscription: SubscriptionCancellationContext,
	request: CancellationRequest,
): Promise<string | null> {
	const { service } = cancellationService(subscription);
	try {
		const preview = await service.previewCommercialAction({
			billingAccountId,
			intent: cancellationIntent(request),
		});
		await service.executeCommercialAction({
			billingAccountId,
			previewToken: preview.previewToken,
			idempotencyKey: "property-1",
		});
		return null;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
}

describe("commercial cancellation capability reads", () => {
	// capability: subscription.cancel
	it("never reports available a cancel or uncancel that execution refuses", async () => {
		const combinations = subscriptionStatuses.flatMap((status) =>
			[false, true].flatMap((cancelAtPeriodEnd) =>
				pendingChangeStatuses.flatMap((pendingChange) =>
					cancellationRequests.map(
						(request) => [status, cancelAtPeriodEnd, pendingChange, request] as const,
					),
				),
			),
		);
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom<SubscriptionStatus>(...subscriptionStatuses),
				fc.boolean(),
				fc.constantFrom(...pendingChangeStatuses),
				fc.constantFrom(...cancellationRequests),
				async (status, cancelAtPeriodEnd, pendingChange, request) => {
					const verdict = evaluateCapability(
						stripeCapabilities,
						request === "uncancel" ? "subscription.uncancel" : "subscription.cancel",
						{ operation: { subscriptionState: status, cancellationPending: cancelAtPeriodEnd } },
					);
					const refused = await refusal(
						context({
							status,
							cancelAtPeriodEnd,
							pendingChange:
								pendingChange === null ? null : { id: "change-1", status: pendingChange },
						}),
						request,
					);
					const stateBlocked = verdict.reasons.some(
						(reason) => reason.code === "SUBSCRIPTION_STATE",
					);
					// Both sides agree on which subscription states Stripe can still cancel.
					expect(stateBlocked).toBe(refused === "SUBSCRIPTION_NOT_CANCELLABLE");
					if (verdict.outcome === "available") {
						// A change a worker holds is a transient lease the declaration does not model: the
						// read reports it as the subscription's pending change, and a retry succeeds.
						expect(refused).toBe(
							request !== "uncancel" && pendingChange === "processing"
								? "SUBSCRIPTION_CHANGE_PENDING"
								: null,
						);
					}
				},
			),
			// Every combination runs as an example first; fast-check counts examples within numRuns.
			{ examples: combinations, numRuns: combinations.length + 100 },
		);
	});
});
