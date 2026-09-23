import { describe, expect, it } from "bun:test";
import type { AdminBillingReader } from "../../src/admin/types";
import type { StripeBillingServiceLike } from "../../src/app/types";
import { BillingError, CapabilityError } from "../../src/billing/errors";
import { createMerchantBillingPort } from "../../src/composition/merchant-billing";
import type { BillingRepository } from "../../src/db/repository";
import type { MerchantBillingCommand } from "../../src/platform/application/billing-port";
import { appleCapabilities } from "../../src/providers/apple/capabilities";
import type { ProviderCapabilityReads } from "../../src/providers/capability-read-types";
import { evaluateCapability } from "../../src/shared/provider-capabilities";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("voysee");
const inactive = projectInstanceContext("wiseley", { lifecycleStatus: "inactive" });

function requiredOnlyStripeService(): StripeBillingServiceLike {
	return {
		async createCheckoutSession() {
			return { sessionId: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" };
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
			return { status: "processed" };
		},
	};
}

/** Records each read and answers with an empty view. */
function recordingCapabilityReads(calls: string[][] = []): ProviderCapabilityReads {
	return {
		async environment(context) {
			calls.push(["environment", context.projectInstanceId]);
			return { schemaVersion: 1, generatedAt: "2026-09-18T12:00:00.000Z", providers: [] };
		},
		async availableActions(context, billingAccountId) {
			calls.push(["availableActions", context.projectInstanceId, billingAccountId]);
			return {
				schemaVersion: 1,
				billingAccountId,
				customerExists: false,
				generatedAt: "2026-09-18T12:00:00.000Z",
				account: [],
				subscriptions: [],
			};
		},
	};
}

function port({
	stripe = requiredOnlyStripeService(),
	repository = {},
	capabilityReads = recordingCapabilityReads(),
}: {
	stripe?: StripeBillingServiceLike | null;
	repository?: Partial<BillingRepository>;
	capabilityReads?: ProviderCapabilityReads;
} = {}) {
	return createMerchantBillingPort({
		repository: repository as BillingRepository,
		reader: {} as AdminBillingReader,
		resolver: projectContextResolver({ contexts: [project, inactive] }),
		providers: {
			appleStoreKitService: async () => null,
			googlePlayBillingService: async () => null,
			stripeBillingService: async () => stripe,
		},
		capabilityReads,
	});
}

function command(
	operation: MerchantBillingCommand["operation"],
	overrides: Partial<MerchantBillingCommand> = {},
): MerchantBillingCommand {
	return {
		operation,
		parameters: ["user_1"],
		projectInstanceId: project.projectInstanceId,
		actor: "merchant@example.com",
		query: {},
		body: undefined,
		idempotencyKey: null,
		...overrides,
	};
}

describe("merchant billing port", () => {
	it("rejects each operation whose Stripe service lacks the method as not configured", async () => {
		const billing = port();

		for (const [operation, adapterMethod, message, overrides] of [
			["account.billing", "reads.billingAccount", "Billing account is unavailable", {}],
			[
				"commercial.preview",
				"commercial.preview",
				"Commercial previews are unavailable",
				{ body: { intent: { kind: "checkout_product", productKey: "credits_100" } } },
			],
			[
				"commercial.execute",
				"commercial.execute",
				"Commercial actions are unavailable",
				{
					body: { previewToken: "11111111-1111-4111-8111-111111111111" },
					idempotencyKey: "execute-1",
				},
			],
			[
				"account.payment-setup",
				"paymentMethods.setupSession",
				"Payment method setup is unavailable",
				{ parameters: ["acct_1", "cs_setup_1"] as string[] },
			],
		] as const) {
			expect(await billing.dispatch(command(operation, overrides)), operation).toEqual({
				status: 503,
				body: {
					success: false,
					error: {
						code: "BILLING_PROVIDER_NOT_CONFIGURED",
						message,
						details: { provider: "stripe", adapterMethod },
					},
				},
			});
		}
	});

	it("dispatches the capability reads for the environment and one billing account", async () => {
		const calls: string[][] = [];
		const billing = port({ capabilityReads: recordingCapabilityReads(calls) });

		expect(await billing.dispatch(command("providers.capabilities", { parameters: [] }))).toEqual({
			status: 200,
			body: {
				success: true,
				data: { schemaVersion: 1, generatedAt: "2026-09-18T12:00:00.000Z", providers: [] },
			},
		});
		expect(await billing.dispatch(command("account.actions"))).toEqual({
			status: 200,
			body: {
				success: true,
				data: {
					schemaVersion: 1,
					billingAccountId: "user_1",
					customerExists: false,
					generatedAt: "2026-09-18T12:00:00.000Z",
					account: [],
					subscriptions: [],
				},
			},
		});
		expect((await billing.dispatch(command("account.actions", { parameters: [" "] }))).status).toBe(
			400,
		);
		expect(calls).toEqual([
			["environment", project.projectInstanceId],
			["availableActions", project.projectInstanceId, "user_1"],
		]);
	});

	it("serves the capability reads to active environments only", async () => {
		const calls: string[][] = [];
		const published = {
			revisionId: null,
			revision: null,
			intentHash: null,
			publishedAt: null,
			catalog: null,
		};
		const billing = port({
			capabilityReads: recordingCapabilityReads(calls),
			repository: { getPublishedCatalog: async () => published },
		});

		// The inactive environment resolves: its catalog stays readable while it awaits activation.
		expect(
			await billing.dispatch(command("catalog", { projectInstanceId: inactive.projectInstanceId })),
		).toEqual({ status: 200, body: { success: true, data: published } });
		for (const operation of ["providers.capabilities", "account.actions"] as const) {
			expect(
				await billing.dispatch(
					command(operation, { projectInstanceId: inactive.projectInstanceId }),
				),
				operation,
			).toEqual({
				status: 404,
				body: {
					success: false,
					error: {
						code: "CONTEXT_UNAVAILABLE",
						message: "The selected environment is unavailable",
					},
				},
			});
		}
		expect(calls).toEqual([]);
	});

	it("keeps the envelope without details when an error carries none", async () => {
		expect(await port({ stripe: null }).dispatch(command("account.billing"))).toEqual({
			status: 503,
			body: {
				success: false,
				error: {
					code: "BILLING_PROVIDER_NOT_CONFIGURED",
					message: "Stripe provider is not configured",
				},
			},
		});
	});

	it("forwards exposed details and hides unexposed ones", async () => {
		const verdict = {
			...evaluateCapability(
				appleCapabilities,
				"checkout.hosted",
				{},
				{ through: "implementation" },
			),
			provider: "apple" as const,
		};
		const message = "Apple StoreKit provider does not support checkout.hosted";
		const capability = port({
			repository: {
				async getCustomerBillingSummary() {
					throw new CapabilityError(message, "provider", { verdict });
				},
			},
		});
		const hidden = port({
			repository: {
				async getCustomerBillingSummary() {
					throw new BillingError("Ledger replica is lagging", "SUMMARY_UNAVAILABLE", 500, {
						exposeMessage: false,
						details: { replica: "billing-2" },
					});
				},
			},
		});

		expect(await capability.dispatch(command("account.summary"))).toEqual({
			status: 400,
			body: {
				success: false,
				error: {
					code: "PROVIDER_CAPABILITY_UNSUPPORTED",
					message,
					details: { verdict },
				},
			},
		});
		expect(await hidden.dispatch(command("account.summary"))).toEqual({
			status: 500,
			body: {
				success: false,
				error: { code: "SUMMARY_UNAVAILABLE", message: "Billing request failed" },
			},
		});
	});
});
