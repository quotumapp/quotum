import { describe, expect, it } from "bun:test";
import type { GooglePlayBillingServiceLike, StripeBillingServiceLike } from "../../src/app/types";
import type { SubscriptionChangeOperation } from "../../src/billing/recurring";
import { createWorkerProviderSelectors } from "../../src/composition/worker-providers";
import type {
	BillingRepository,
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
} from "../../src/db/repository";
import type { StripeBillingEnv } from "../../src/env";
import type {
	RuntimeConnectionKind,
	RuntimeConnectionResolver,
} from "../../src/projects/connections";
import { createProviderRegistry } from "../../src/providers/registry";
import { FakeStripeBillingClient } from "../../src/providers/stripe/testing/fake-client";
import { projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("voysee");
const otherProject = projectInstanceContext("wiseley");

const stripeConfig: StripeBillingEnv = {
	secretKey: "sk_test_worker_providers",
	webhookSecret: "whsec_worker_providers",
	checkoutSuccessUrl: "https://voysee.example.com/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://voysee.example.com/cancel",
	portalReturnUrl: "https://voysee.example.com/account",
};

function recordingConnections(configured: { stripe?: StripeBillingEnv } = {}) {
	const resolved: Array<{ project: string; kind: RuntimeConnectionKind; purpose?: string }> = [];
	const connections = {
		async resolve(context, kind, purpose) {
			resolved.push({ project: context.projectInstanceKey, kind, purpose });
			if (context.projectInstanceKey !== project.projectInstanceKey) return null;
			return (configured as Record<string, unknown>)[kind] ?? null;
		},
	} as RuntimeConnectionResolver;
	return { connections, resolved };
}

const fakeRepository = () => ({ forProject: () => ({}) }) as unknown as BillingRepository;

const unusedRepository = (): BillingRepository => {
	throw new Error("repository must not be built");
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

const stripeFake: StripeBillingServiceLike = {
	async createCheckoutSession() {
		return { sessionId: "cs_override", url: "https://checkout.stripe.com/c/pay/cs_override" };
	},
	async createPortalSession() {
		return { url: "https://billing.stripe.com/p/session" };
	},
	async getCheckoutSessionStatus(input) {
		return {
			sessionId: input.sessionId,
			status: "open",
			paymentStatus: "unpaid",
			customerEmail: null,
			productKey: null,
		};
	},
	async handleWebhook() {
		return { status: "ignored" };
	},
};

const googleFake: GooglePlayBillingServiceLike = {
	async getAccountLink(billingAccountId) {
		return { obfuscatedAccountId: `gpa-for-${billingAccountId}` };
	},
	async verifyPurchase() {
		return {};
	},
	async handleRtdn() {
		return { status: "ignored" };
	},
};

const change: SubscriptionChangeOperation = {
	changeId: "change-1",
	projectInstanceId: project.projectInstanceId,
	projectKey: project.projectInstanceKey,
	provider: "stripe",
	providerAccountId: null,
	status: "processing",
	changeKind: "upgrade",
	effectiveMode: "immediate",
	effectiveAt: "2026-01-01T00:00:00.000Z",
	prorationBehavior: "always_invoice",
	externalSubscriptionId: "sub_1",
	targetPlanVersionId: "2",
	discountCouponId: null,
	promotionRedemption: null,
	items: [],
};

describe("worker provider selectors", () => {
	it("builds each job's adapter from the recovery connection and the shared client factories", async () => {
		const { connections, resolved } = recordingConnections({ stripe: stripeConfig });
		const clientsFor: string[] = [];
		const selectors = createWorkerProviderSelectors(
			createProviderRegistry({
				connections,
				getRepository: fakeRepository,
				clientFactories: {
					stripe(config, projectInstanceKey) {
						clientsFor.push(projectInstanceKey);
						return new FakeStripeBillingClient(config);
					},
				},
			}),
		);

		const recurring = await selectors.recurringBilling(project, "stripe");
		const topup = await selectors.autoTopup(project, "stripe");
		const promotions = await selectors.promotionMaintenance(project, "stripe");

		expect(typeof recurring.changes?.apply).toBe("function");
		expect(typeof recurring.settlement?.collectFinalizedCharge).toBe("function");
		expect(typeof topup.topups?.chargeAutomatic).toBe("function");
		expect(typeof promotions?.promotions?.syncObject).toBe("function");
		expect(resolved).toEqual([
			{ project: "voysee", kind: "stripe", purpose: "recovery" },
			{ project: "voysee", kind: "stripe", purpose: "recovery" },
			{ project: "voysee", kind: "stripe", purpose: "recovery" },
		]);
		expect(clientsFor).toEqual(["voysee", "voysee", "voysee"]);
	});

	it("keeps the not-configured texts and defers promotions without a connection", async () => {
		const selectors = createWorkerProviderSelectors(
			createProviderRegistry({
				connections: recordingConnections().connections,
				getRepository: unusedRepository,
			}),
		);

		expect(await rejection(selectors.recurringBilling(project, "stripe"))).toEqual(
			new Error("Stripe is not configured for voysee"),
		);
		expect(await rejection(selectors.autoTopup(otherProject, "stripe"))).toEqual(
			new Error("Stripe is not configured for wiseley"),
		);
		expect(await rejection(selectors.recurringBilling(project, "apple"))).toEqual(
			new Error("Apple StoreKit is not configured for voysee"),
		);
		expect(await selectors.promotionMaintenance(project, "stripe")).toBeNull();
	});

	it("returns replay and reconciliation providers only under the job's provider", async () => {
		const replayed: string[] = [];
		const reconciled: string[] = [];
		const googleService = {
			...googleFake,
			async replayStoreEvent(event: StoreEventReplayJobRow) {
				replayed.push(event.id);
				return { status: "processed" as const };
			},
			async reconcileSubscription(subscription: ProviderSubscriptionReconciliationRow) {
				reconciled.push(subscription.id);
				return { status: "processed" as const };
			},
		};
		const { connections, resolved } = recordingConnections();
		const selectors = createWorkerProviderSelectors(
			createProviderRegistry({
				connections,
				getRepository: unusedRepository,
				overrides: { voysee: { googlePlayBillingService: googleService } },
			}),
		);

		const replay = await selectors.storeEventReplay(project, "google");
		const reconciliation = await selectors.subscriptionReconciliation(project, "google");

		expect({ apple: replay.apple, stripe: replay.stripe }).toEqual({ apple: null, stripe: null });
		expect(
			await replay.google?.replayStoreEvent({ id: "event-1" } as StoreEventReplayJobRow),
		).toEqual({ status: "processed" });
		expect({ apple: reconciliation.apple, stripe: reconciliation.stripe }).toEqual({
			apple: null,
			stripe: null,
		});
		await reconciliation.google?.reconcileSubscription({
			id: "subscription-1",
		} as ProviderSubscriptionReconciliationRow);
		expect(replayed).toEqual(["event-1"]);
		expect(reconciled).toEqual(["subscription-1"]);
		expect(resolved).toEqual([]);

		expect(await selectors.storeEventReplay(otherProject, "google")).toEqual({
			apple: null,
			google: null,
			stripe: null,
		});
		expect(await selectors.subscriptionReconciliation(otherProject, "google")).toEqual({
			apple: null,
			google: null,
			stripe: null,
		});
		expect(resolved).toEqual([
			{ project: "wiseley", kind: "google", purpose: "recovery" },
			{ project: "wiseley", kind: "google", purpose: "recovery" },
		]);
	});

	it("serves worker adapters from per-project service overrides", async () => {
		const stripeService = {
			...stripeFake,
			async applySubscriptionChange(operation: SubscriptionChangeOperation) {
				return `request-for-${operation.changeId}`;
			},
		};
		const { connections, resolved } = recordingConnections({ stripe: stripeConfig });
		const selectors = createWorkerProviderSelectors(
			createProviderRegistry({
				connections,
				getRepository: unusedRepository,
				overrides: { voysee: { stripeBillingService: stripeService } },
			}),
		);

		const adapter = await selectors.recurringBilling(project, "stripe");

		expect(await adapter.changes?.apply(change)).toMatchObject({
			outcome: "committed",
			providerRequestId: "request-for-change-1",
		});
		expect(adapter.settlement).toBeUndefined();
		expect(resolved).toEqual([]);
	});
});
