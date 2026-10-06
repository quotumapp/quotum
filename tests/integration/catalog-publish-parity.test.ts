import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);

let context: LocalPostgresContext;

// biome-ignore lint/suspicious/noExplicitAny: catalog bodies and responses are asserted field by field
type Json = Record<string, any>;

const creditsFeature = {
	key: "ai_credits",
	name: "AI credits",
	kind: "metered",
	meterKind: "consumable",
	unit: "credit",
	creditScale: 3,
	filterDimensions: [] as string[],
};

/** A priced plan bound to the seeded Stripe product, with one allowance and one top-up. */
function catalog(version = 1, quantity = "1000"): Json {
	return {
		features: [{ ...creditsFeature }],
		plans: [
			{
				key: "premium",
				name: "Premium",
				version,
				kind: "base",
				basePrice: {
					key: "premium_monthly",
					currency: "USD",
					unitAmountMinor: 999,
					billingUnits: "1",
					billingInterval: "month",
					minimumQuantity: 1,
					maximumQuantity: 1,
					taxBehavior: "exclusive",
					providerBindings: [{ productKey: "premium_monthly", provider: "stripe", channel: "web" }],
				},
				providerPriced: null,
				items: [
					{
						itemKind: "allocation",
						featureKey: "ai_credits",
						quantity,
						reset: { interval: "month", intervalCount: 1 },
					},
				],
			},
		],
		topups: [
			{
				key: "ai_credits_10",
				featureKey: "ai_credits",
				quantity: "10",
				expiry: { mode: "forever" },
				providerBindings: [{ productKey: "echo_credits_10", provider: "stripe", channel: "web" }],
			},
		],
		rateCards: [],
	};
}

localDescribe("catalog preview and publish parity", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function operator() {
		const { app, authHeaders } = createIntegrationApp({
			env: {
				...context.env,
				rateLimit: { ...context.env.rateLimit, adminLimit: 1_000_000 },
			},
			repository: context.repository,
		});
		const headers = {
			...(authHeaders() as Record<string, string>),
			"content-type": "application/json",
			"x-billing-actor": "parity-test",
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
		};
		const call = async (path: string, body: unknown) => {
			const response = await testRequest(app, path, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			return { status: response.status, body: (await response.json()) as Json };
		};
		return {
			preview: (catalogBody: unknown, expectedRevision: number | null = null) =>
				call("/v1/admin/catalog/preview", { expectedRevision, catalog: catalogBody }),
			publish: (
				catalogBody: unknown,
				previewToken: string,
				expectedRevision: number | null = null,
			) =>
				call("/v1/admin/catalog/publish", {
					expectedRevision,
					previewToken,
					catalog: catalogBody,
				}),
		};
	}

	it("refuses an integer a Postgres column cannot hold at preview, not at publish", async () => {
		const { preview } = operator();
		const tooLarge = 2 ** 31;
		const cases: Array<[string, (body: Json) => void]> = [
			["version", (body) => (body.plans[0].version = tooLarge)],
			["tierRank", (body) => (body.plans[0].tierRank = tooLarge)],
			["tierRank", (body) => (body.plans[0].tierRank = -tooLarge - 1)],
			[
				"minimumQuantity",
				(body) =>
					Object.assign(body.plans[0].basePrice, {
						minimumQuantity: tooLarge,
						maximumQuantity: null,
					}),
			],
			["maximumQuantity", (body) => (body.plans[0].basePrice.maximumQuantity = tooLarge)],
		];
		for (const [field, mutate] of cases) {
			const body = catalog();
			mutate(body);
			const refused = await preview(body);
			expect({ field, status: refused.status, code: refused.body.error?.code }).toEqual({
				field,
				status: 400,
				code: "INVALID_REQUEST",
			});
		}
		expect(await context.sql`SELECT id FROM catalog_drafts`).toHaveLength(0);
	});

	it("publishes the largest integers a Postgres column holds", async () => {
		const { preview, publish } = operator();
		const body = catalog(2 ** 31 - 1);
		body.plans[0].tierRank = 2 ** 31 - 1;
		Object.assign(body.plans[0].basePrice, { minimumQuantity: 1, maximumQuantity: 2 ** 31 - 1 });
		const previewed = await preview(body);
		expect(previewed.status).toBe(200);
		const published = await publish(body, previewed.body.data.previewToken);
		expect(published.status).toBe(200);
		const [row] = await context.sql<Array<{ version: number; tier_rank: number }>>`
			SELECT version, tier_rank FROM plan_versions
		`;
		expect({ ...row }).toEqual({ version: 2 ** 31 - 1, tier_rank: 2 ** 31 - 1 });
	});

	it("names a price key used twice in one plan at preview", async () => {
		const { preview } = operator();
		const body = catalog();
		body.features.push({
			key: "seats",
			name: "Seats",
			kind: "metered",
			meterKind: "non_consumable",
			unit: "seat",
			creditScale: 0,
			filterDimensions: [],
		});
		body.plans[0].items.push({
			itemKind: "licensed_quantity",
			featureKey: "seats",
			quantity: "5",
			allocationScope: "license_pool",
			price: { ...body.plans[0].basePrice, maximumQuantity: null },
		});
		const refused = await preview(body);
		expect(refused.status).toBe(400);
		expect(refused.body.error).toMatchObject({
			code: "INVALID_REQUEST",
			message: "Plan premium uses price key premium_monthly more than once",
		});
	});

	for (const round of [1, 2, 3]) {
		it(`lets one of ten parallel first publishes win and answers the rest with a conflict (round ${round})`, async () => {
			const { preview, publish } = operator();
			const bodies = Array.from({ length: 10 }, (_, index) => catalog(1, String(100 + index)));
			const previews = await Promise.all(bodies.map((body) => preview(body)));
			const results = await Promise.all(
				bodies.map((body, index) =>
					publish(body, previews[index]?.body.data.previewToken as string),
				),
			);
			const statuses = results.map((result) => result.status).sort();
			expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
			for (const loser of results.filter((result) => result.status === 409)) {
				expect(loser.body.error).toMatchObject({
					code: "CATALOG_REVISION_CONFLICT",
					message: "Expected catalog revision null, current revision is 1",
				});
			}
			expect(await context.sql`SELECT revision FROM catalog_revisions`).toHaveLength(1);
		});
	}

	it("reports the true revision to a publish that lost against a later revision", async () => {
		const { preview, publish } = operator();
		const first = catalog(1);
		const firstPreview = await preview(first);
		expect((await publish(first, firstPreview.body.data.previewToken)).status).toBe(200);
		const bodies = Array.from({ length: 6 }, (_, index) => catalog(2 + index, String(200 + index)));
		const previews = await Promise.all(bodies.map((body) => preview(body, 1)));
		const results = await Promise.all(
			bodies.map((body, index) =>
				publish(body, previews[index]?.body.data.previewToken as string, 1),
			),
		);
		expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
		for (const loser of results.filter((result) => result.status === 409)) {
			expect(loser.body.error.message).toBe("Expected catalog revision 1, current revision is 2");
		}
	});

	it("refuses a changed plan under a version below one the plan already has", async () => {
		const { preview, publish } = operator();
		const publishNext = async (body: Json, expectedRevision: number | null) => {
			const previewed = await preview(body, expectedRevision);
			expect(previewed.status).toBe(200);
			return await publish(body, previewed.body.data.previewToken, expectedRevision);
		};
		expect((await publishNext(catalog(1), null)).status).toBe(200);
		// Version numbers may skip.
		expect((await publishNext(catalog(5, "5000"), 1)).status).toBe(200);
		const refused = await preview(catalog(2, "2000"), 2);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatchObject({
			code: "PLAN_VERSION_CONFLICT",
			message:
				"Plan premium version 2 is below its latest version 5; a changed plan takes a higher version",
		});
		const [active] = await context.sql<Array<{ version: number }>>`
			SELECT version.version
			FROM plans plan
			JOIN plan_versions version ON version.id = plan.active_version_id
			WHERE plan.key = 'premium'
		`;
		expect(active?.version).toBe(5);
		expect((await publishNext(catalog(6, "2000"), 2)).status).toBe(200);
	});

	it("refuses at preview a plan version that already exists with other content", async () => {
		const { preview, publish } = operator();
		const first = catalog(1);
		const previewed = await preview(first);
		expect((await publish(first, previewed.body.data.previewToken)).status).toBe(200);
		const refused = await preview(catalog(1, "2000"), 1);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatchObject({
			code: "PLAN_VERSION_CONFLICT",
			message: "Plan premium version 1 already exists",
		});
		// The published catalog read back is unchanged, so nothing is created and nothing is refused.
		const again = await preview(first, 1);
		expect(again.status).toBe(200);
		expect(again.body.data.impact.planVersionsCreated).toBe(0);
		expect(await context.sql`SELECT id FROM catalog_drafts`).toHaveLength(2);
	});

	it("refuses at preview a feature whose meter semantics changed", async () => {
		const { preview, publish } = operator();
		const first = catalog(1);
		const previewed = await preview(first);
		expect((await publish(first, previewed.body.data.previewToken)).status).toBe(200);
		for (const change of [{ creditScale: 0 }, { unit: "token" }, { filterDimensions: ["model"] }]) {
			const next = catalog(2);
			Object.assign(next.features[0], change);
			const refused = await preview(next, 1);
			expect(refused.status).toBe(409);
			expect(refused.body.error).toMatchObject({
				code: "FEATURE_IDENTITY_CONFLICT",
				message: "Feature ai_credits changes immutable meter semantics",
			});
		}
		const renamed = catalog(2);
		renamed.features[0].name = "Renamed credits";
		expect((await preview(renamed, 1)).status).toBe(200);
	});

	it("refuses at preview a custom plan for an unknown customer", async () => {
		const { preview } = operator();
		const body = catalog();
		Object.assign(body.plans[0], {
			visibility: "customer_specific",
			customerBillingAccountId: "ghost_account",
		});
		const refused = await preview(body);
		expect(refused.status).toBe(400);
		expect(refused.body.error).toMatchObject({
			code: "INVALID_REQUEST",
			message: "Custom plan customer ghost_account was not found",
		});
	});

	it("refuses at preview a top-up bound to a product that is not mapped", async () => {
		const { preview } = operator();
		const body = catalog();
		body.topups[0].providerBindings = [
			{ productKey: "unmapped_pack", provider: "stripe", channel: "web" },
		];
		const refused = await preview(body);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatchObject({
			code: "PROVIDER_BINDING_NOT_READY",
			message:
				"Top-up binding stripe/web/unmapped_pack for top-up ai_credits_10 is not ready: no active consumable product is mapped",
		});
	});

	it("replays a publish only for the request that was published", async () => {
		const { preview, publish } = operator();
		const body = catalog();
		const token = (await preview(body)).body.data.previewToken as string;
		const first = await publish(body, token);
		expect(first.status).toBe(200);
		expect(first.body.data).toMatchObject({ revision: 1, duplicate: false });

		// A retry of the same request is answered with that publish.
		const retry = await publish(body, token);
		expect(retry.status).toBe(200);
		expect(retry.body.data).toMatchObject({
			revisionId: first.body.data.revisionId,
			revision: 1,
			duplicate: true,
		});

		// Another expected revision or another catalog under the token is not that request.
		const otherRevision = await publish(body, token, 9999);
		expect(otherRevision.status).toBe(409);
		expect(otherRevision.body.error).toMatchObject({
			code: "CATALOG_REVISION_CONFLICT",
			message:
				"Expected catalog revision 9999, but this preview was published from an empty catalog",
		});
		const otherCatalog = await publish(catalog(2, "9"), token);
		expect(otherCatalog.status).toBe(409);
		expect(otherCatalog.body.error.code).toBe("CATALOG_PREVIEW_MISMATCH");

		const [state] = await context.sql`
			SELECT count(*)::int AS revisions, max(revision)::int AS latest FROM catalog_revisions`;
		expect(state).toEqual({ revisions: 1, latest: 1 });
	});
});
