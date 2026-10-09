import { describe, expect, it } from "bun:test";
import { BillingError } from "../../../src/billing/errors";
import type { BindingAdoption, BindingResult } from "../../../src/catalog/bindings";
import type { CatalogPreview, CatalogPublishResult } from "../../../src/catalog/types";
import { createDirectCatalogApi } from "../../../src/composition/cli/direct-catalog";
import type { ProjectInstanceContext } from "../../../src/projects/context";
import { BillingApiError } from "../../../src/sdk/client";

const project = { projectInstanceId: "instance-1", projectInstanceKey: "alpha" } as never;
const stripe = (productKey: string) => ({ productKey, provider: "stripe", channel: "web" });
/** The smallest catalog the preview schema accepts: one metered feature and one Stripe-bound plan. */
const catalog = {
	features: [
		{
			key: "ai_credits",
			name: "AI credits",
			kind: "metered",
			meterKind: "consumable",
			unit: "credit",
			creditScale: 0,
			filterDimensions: [],
		},
	],
	plans: [
		{
			key: "pro",
			name: "Pro",
			version: 1,
			trialDays: null,
			currency: "USD",
			baseAmountMinor: 2000,
			billingInterval: "month",
			basePrice: {
				key: "pro_monthly",
				currency: "USD",
				unitAmountMinor: 2000,
				billingUnits: "1",
				billingInterval: "month",
				minimumQuantity: 1,
				maximumQuantity: 1,
				taxBehavior: "exclusive",
				providerBindings: [stripe("pro_monthly")],
			},
			providerBindings: [stripe("pro_monthly")],
			items: [
				{
					featureKey: "ai_credits",
					itemKind: "allocation",
					quantity: "1000",
					resetInterval: "month",
					expiresAfterSeconds: 86400,
					overagePolicy: "blocked",
				},
			],
		},
	],
	topups: [],
	rateCards: [],
} as never;
const adoption: BindingAdoption = {
	productKey: "pro_monthly",
	name: "Pro monthly",
	kind: "subscription",
	entitlementKey: "pro",
	credits: 1000,
	externalProductId: "prod_pro",
	externalPriceId: "price_pro",
};
const previewToken = "a".repeat(64);

/** Records every call, in order, across the authorization and the repository. */
function harness(overrides: { authorize?: (write: boolean) => Promise<void> } = {}) {
	const calls: unknown[][] = [];
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push([name, ...args]);
			return { name } as never;
		};
	const api = createDirectCatalogApi({
		repository: {
			getPublishedCatalog: record("getPublishedCatalog"),
			previewCatalog: record("previewCatalog"),
			publishCatalog: record("publishCatalog"),
		},
		bindings: {
			list: record("bindings.list") as never,
			adopt: record("bindings.adopt") as never,
		},
		project: project as ProjectInstanceContext,
		operator: "ops-runbook",
		authorize:
			overrides.authorize ??
			(async (write) => {
				calls.push(["authorize", write]);
			}),
	});
	return { api, calls };
}

describe("direct catalog API", () => {
	it("authorizes a read, then reads the published catalog and the bindings", async () => {
		const { api, calls } = harness();
		await api.status();
		await api.bindings.list();
		expect(calls).toEqual([
			["authorize", false],
			["getPublishedCatalog", project],
			["authorize", false],
			["bindings.list", project],
		]);
	});

	it("authorizes a change before it previews or publishes, naming the operator", async () => {
		const { api, calls } = harness();
		await api.preview({ expectedRevision: null, catalog });
		await api.publish({ expectedRevision: 2, previewToken, catalog });
		expect(calls.map(([name]) => name)).toEqual([
			"authorize",
			"previewCatalog",
			"authorize",
			"publishCatalog",
		]);
		expect(calls[0]).toEqual(["authorize", true]);
		expect(calls[1]).toMatchObject([
			"previewCatalog",
			project,
			{ expectedRevision: null, actor: "operator:ops-runbook" },
		]);
		expect(calls[3]).toMatchObject([
			"publishCatalog",
			project,
			{ expectedRevision: 2, previewToken, actor: "operator:ops-runbook" },
		]);
	});

	it("authorizes an adoption as a change and records the operator and the request key", async () => {
		const { api, calls } = harness();
		await api.bindings.adopt(adoption, "binding:key-1");
		expect(calls).toEqual([
			["authorize", true],
			["bindings.adopt", project, adoption, "operator:ops-runbook", "binding:key-1"],
		]);
	});

	it("does nothing when the operator is refused", async () => {
		const refusal = new Error("This organization has members");
		const { api, calls } = harness({
			authorize: async (write) => {
				calls.push(["authorize", write]);
				throw refusal;
			},
		});
		for (const run of [
			() => api.status(),
			() => api.preview({ expectedRevision: null, catalog }),
			() => api.publish({ expectedRevision: null, previewToken, catalog }),
			() => api.bindings.list(),
			() => api.bindings.adopt(adoption, "k"),
		])
			await expect(run()).rejects.toBe(refusal);
		// Every operation asked, none went further.
		expect(calls.map(([name]) => name)).toEqual(Array(5).fill("authorize"));
	});

	it("refuses invalid input as the HTTP route does, without calling the repository", async () => {
		const { api, calls } = harness();
		const error = await api
			.preview({ expectedRevision: 0, catalog })
			.then(() => null)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BillingApiError);
		expect(error).toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		expect((error as Error).message).toContain("body.expectedRevision");
		const badToken = await api
			.publish({ expectedRevision: null, previewToken: "not-a-token", catalog })
			.then(() => null)
			.catch((caught: unknown) => caught);
		expect(badToken).toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		const badBinding = await api.bindings
			.adopt({ ...adoption, externalPriceId: "nope" }, "k")
			.then(() => null)
			.catch((caught: unknown) => caught);
		expect(badBinding).toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		// Authorization ran each time; nothing after it did.
		expect(calls.map(([name]) => name)).toEqual(["authorize", "authorize", "authorize"]);
	});

	it("throws a domain refusal as the client does, keeping its code, status and details", async () => {
		const refusal = new BillingError("The catalog changed", "CATALOG_REVISION_CONFLICT", 409, {
			details: { currentRevision: 4 },
		});
		const api = createDirectCatalogApi({
			repository: {
				getPublishedCatalog: async () => {
					throw refusal;
				},
				previewCatalog: async () => ({}) as CatalogPreview,
				publishCatalog: async () => ({}) as CatalogPublishResult,
			},
			bindings: {
				list: async () => [] as BindingResult[],
				adopt: async () => {
					throw new BillingError("No Stripe connection", "CONNECTION_UNAVAILABLE", 503);
				},
			},
			project: project as ProjectInstanceContext,
			operator: "ops-runbook",
			authorize: async () => {},
		});
		const status = await api.status().catch((caught: unknown) => caught);
		expect(status).toBeInstanceOf(BillingApiError);
		expect(status).toMatchObject({
			message: "The catalog changed",
			code: "CATALOG_REVISION_CONFLICT",
			status: 409,
			details: { currentRevision: 4 },
		});
		await expect(api.bindings.adopt(adoption, "k")).rejects.toMatchObject({
			code: "CONNECTION_UNAVAILABLE",
			status: 503,
		});
	});
});
