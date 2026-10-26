import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { MerchantBillingOperation } from "../../src/platform/application/billing-port";
import { McpAuthorizations } from "../../src/platform/mcp/authorization";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { createFakeStripeBillingClient } from "../../tests/integration/helpers/fake-provider-clients";
import { MerchantBrowser, merchantFixture, onboard } from "./fixture";

const f = merchantFixture({
	mcp: { origin: "https://api.example.test", writesEnabled: true, proposalTtlSeconds: 7200 },
	providers: {
		appleStoreKitService: async () => null,
		googlePlayBillingService: async () => null,
		stripeBillingService: async (project) =>
			new StripeBillingService({
				config: {
					checkoutSuccessUrl: "https://merchant.example.test/success",
					checkoutCancelUrl: "https://merchant.example.test/cancel",
					portalReturnUrl: "https://merchant.example.test/billing",
				},
				client: createFakeStripeBillingClient().client,
				repository: f.repository.forProject(project),
			}),
	},
});
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
const target = { projectKey: "example", environment: "sandbox" as const };
const catalog = {
	features: [
		{
			key: "credits",
			name: "Credits",
			kind: "metered",
			meterKind: "consumable",
			unit: "credit",
			creditScale: 0,
			filterDimensions: [],
		},
	],
	plans: ["basic", "pro"].map((key) => ({
		key,
		name: key,
		version: 1,
		items: [
			{
				itemKind: "allocation",
				featureKey: "credits",
				quantity: "100",
				reset: { interval: "month", intervalCount: 1 },
			},
		],
	})),
	topups: [],
	rateCards: [],
};

async function setup() {
	const browser = new MerchantBrowser(f);
	await onboard(browser);
	const identity = await f.store.authenticate(
		new Request("https://merchant.example.test", {
			headers: { cookie: [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
		}),
	);
	const [grant] = await f.sql<{ id: string }[]>`
		INSERT INTO platform_mcp_authorizations(principal_id,organization_id,client_id,client_name,scopes,expires_at,approved_at)
		SELECT principal_id,organization_id,'quotum-claude-code','Expiry test','["quotum.read","quotum.billing.write"]'::jsonb,now()+interval '30 days',now()
		FROM platform_memberships LIMIT 1 RETURNING id`;
	if (!grant) throw new Error("Missing grant");
	const { context } = await new McpAuthorizations(f.store).target(grant.id, target);
	await f.sql`INSERT INTO customers(project_id,billing_account_id) VALUES(${context.projectInstanceId},'customer-a')`;
	const dispatch = (operation: MerchantBillingOperation, body: unknown) =>
		f.billingPort.dispatch({
			...context,
			operation,
			body,
			parameters: [],
			query: {},
			idempotencyKey: null,
		});
	const body = { catalog, expectedRevision: null };
	const preview = await dispatch("catalog.preview", body);
	expect(preview.status).toBe(200);
	const data = (preview.body as { data: { previewToken: string; expiresAt: string } }).data;
	expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
	expect(Date.parse(data.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
	expect(
		(await dispatch("catalog.publish", { ...body, previewToken: data.previewToken })).status,
	).toBe(200);
	return { identity, grant, dispatch };
}

describe("MCP domain preview lifetime", () => {
	const proposals = [
		{ action: "catalog.publish", body: () => ({ catalog, expectedRevision: 1 }) },
		{
			action: "contracts.publish",
			body: () => ({
				billingAccountId: "customer-a",
				contractKey: "review",
				version: 1,
				planKey: "basic",
				effectiveAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		},
		{
			action: "migrations.publish",
			body: () => ({
				fromPlanKey: "basic",
				fromVersion: 1,
				toPlanKey: "pro",
				toVersion: 1,
				effectiveMode: "immediate",
			}),
		},
		{
			action: "commercial.execute",
			body: () => ({ intent: { kind: "setup_payment", currency: "usd" } }),
		},
	];
	it.each(proposals)(
		"extends $action previews and applies after thirty minutes",
		async ({ action, body }) => {
			const { identity, grant } = await setup();
			const saved = await f.mcpChanges.prepare(grant.id, target, {
				action,
				body: body(),
				parameters: action === "commercial.execute" ? ["customer-a"] : [],
				requestKey: "long-review",
				reason: "Review with more time",
			});
			expect(Date.parse(saved.expiresAt) - Date.now()).toBeGreaterThan(119 * 60_000);
			expect(Date.parse(saved.expiresAt) - Date.now()).toBeLessThanOrEqual(120 * 60_000);
			const [row] = await f.sql<
				{ preview: { expiresAt: string } }[]
			>`SELECT preview FROM platform_mcp_changes WHERE id=${saved.id}`;
			expect(row?.preview.expiresAt).toBe(saved.expiresAt);
			const later = Date.now() + 31 * 60_000;
			const clock = spyOn(Date, "now").mockReturnValue(later);
			try {
				// The review lifetime is independent of the merchant's thirty-minute idle session.
				await f.sql`UPDATE platform_merchant_sessions SET last_seen_at=${f.store.now()} WHERE id=${identity.sessionId}`;
				expect((await f.mcpChanges.get(grant.id, saved.id)).status).toBe("pending");
				const applied = await f.mcpChanges.decide(identity, saved.id, true, null);
				expect(applied.status).toBe("completed");
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("keeps the expiry of a reused enterprise preview", async () => {
		const { grant, dispatch } = await setup();
		const body = proposals[1]?.body();
		const original = await dispatch("contracts.preview", body);
		expect(original.status).toBe(200);
		const data = (original.body as { data: { previewToken: string; expiresAt: string } }).data;
		const saved = await f.mcpChanges.prepare(grant.id, target, {
			action: "contracts.publish",
			body,
			parameters: [],
			requestKey: "reuse",
			reason: "Reuse preview",
		});
		expect(saved.expiresAt).toBe(data.expiresAt);
		const [row] = await f.sql<
			{ preview: { previewToken: string } }[]
		>`SELECT preview FROM platform_mcp_changes WHERE id=${saved.id}`;
		expect(row?.preview.previewToken).toBe(data.previewToken);
	});
});
