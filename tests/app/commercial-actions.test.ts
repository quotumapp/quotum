import { describe, expect, it } from "bun:test";
import { executeCommercial, previewCommercial } from "../../src/app/commercial-actions";
import type { ProjectProviderServiceResolver } from "../../src/app/types";
import type { CommercialActionExecutionResult } from "../../src/billing/commercial";
import { BillingError } from "../../src/billing/errors";
import type { WebBillingService } from "../../src/billing/web-provider";
import { storedCommercialPreview } from "../helpers/commercial-preview";
import { projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("acme");
const receipt: Extract<CommercialActionExecutionResult, { kind: "checkout" }> = {
	kind: "checkout",
	sessionId: "txn_example",
	url: "https://example.com/pay",
	duplicate: false,
};
function fixture() {
	const stored = storedCommercialPreview("paddle");
	const calls: string[] = [];
	const provider: WebBillingService = {
		createCheckoutSession: async () => receipt,
		createPortalSession: async () => ({ url: "https://example.com/portal" }),
		getCheckoutSessionStatus: async () => ({
			sessionId: "txn_example",
			status: "open",
			paymentStatus: "unpaid",
			customerEmail: null,
			productKey: null,
		}),
		handleWebhook: async () => ({ status: "processed" }),
		previewCommercialAction: async () => stored.preview,
		executeCommercialAction: async () => receipt,
	};
	const services: ProjectProviderServiceResolver = {
		appleStoreKitService: async () => null,
		googlePlayBillingService: async () => null,
		stripeBillingService: async () => {
			calls.push("stripe");
			return provider;
		},
		paddleBillingService: async () => {
			calls.push("active");
			return provider;
		},
		paddleBillingServiceVersion: async (_project, version) => {
			calls.push(version);
			return provider;
		},
	};
	const input = {
		project,
		billingAccountId: "user_1",
		services,
		previewToken: stored.preview.previewToken,
		idempotencyKey: "purchase",
		reader: {
			getCommercialActionPreview: async (
				context: typeof project,
				account: string,
				token: string,
			) => {
				expect([context.projectInstanceId, account, token]).toEqual([
					project.projectInstanceId,
					"user_1",
					stored.preview.previewToken,
				]);
				return stored;
			},
		},
	};
	return { stored, calls, provider, input };
}

describe("common commercial provider routing", () => {
	it("selects the explicit preview provider and the persisted execution provider", async () => {
		const f = fixture();
		await previewCommercial({ ...f.input, provider: "paddle", intent: f.stored.intent });
		expect(await executeCommercial(f.input)).toEqual(receipt);
		f.stored.preview.provider = "stripe";
		await executeCommercial(f.input);
		expect(f.calls).toEqual(["active", "active", "stripe"]);
	});
	it("resumes against the recorded version and fails closed if it cannot be loaded", async () => {
		const f = fixture();
		f.stored.status = "executing";
		f.stored.executionIdempotencyKey = "purchase";
		const versionId = "44444444-4444-4444-8444-444444444444";
		f.stored.providerContext = { ...f.stored.providerContext, connectionVersionId: versionId };
		expect(await executeCommercial(f.input)).toEqual(receipt);
		expect(f.calls).toEqual([versionId]);
		f.input.services.paddleBillingServiceVersion = async () => null;
		await expect(executeCommercial(f.input)).rejects.toMatchObject({
			code: "BILLING_PROVIDER_NOT_CONFIGURED",
		});
		f.stored.providerContext = {};
		await expect(executeCommercial(f.input)).rejects.toMatchObject({
			code: "COMMERCIAL_PREVIEW_STALE",
		});
		expect(f.calls).not.toContain("active");
	});
	it("replays a completed receipt without resolving a connection and rejects a different key", async () => {
		const f = fixture();
		f.stored.status = "executed";
		f.stored.executionResult = receipt;
		f.stored.executionIdempotencyKey = "purchase";
		f.stored.providerContext = {};
		expect(await executeCommercial(f.input)).toEqual(receipt);
		await expect(
			executeCommercial({ ...f.input, idempotencyKey: "replacement" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		expect(f.calls).toEqual([]);
	});
	it("does not select a provider for a missing or foreign preview", async () => {
		const f = fixture();
		f.input.reader.getCommercialActionPreview = async () => {
			throw new BillingError("Missing", "COMMERCIAL_PREVIEW_NOT_FOUND", 404);
		};
		await expect(executeCommercial(f.input)).rejects.toMatchObject({
			code: "COMMERCIAL_PREVIEW_NOT_FOUND",
		});
		expect(f.calls).toEqual([]);
	});
	it("refuses missing connections and optional methods with provider details", async () => {
		const f = fixture();
		delete f.provider.previewCommercialAction;
		delete f.provider.executeCommercialAction;
		await expect(
			previewCommercial({ ...f.input, provider: "paddle", intent: f.stored.intent }),
		).rejects.toMatchObject({
			status: 503,
			details: { provider: "paddle", adapterMethod: "commercial.preview" },
		});
		await expect(executeCommercial(f.input)).rejects.toMatchObject({
			status: 503,
			details: { provider: "paddle", adapterMethod: "commercial.execute" },
		});
		f.input.services.paddleBillingService = async () => null;
		await expect(executeCommercial(f.input)).rejects.toMatchObject({
			code: "BILLING_PROVIDER_NOT_CONFIGURED",
		});
	});
});
