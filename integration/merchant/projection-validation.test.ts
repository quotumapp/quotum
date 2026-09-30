import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import type { MerchantScope } from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture, onboard, stubEnvironmentBilling } from "./fixture";

/** Receiver names and what the resolver answers for each; nothing here is ever contacted. */
const resolved: Record<string, string> = {
	"private.example.com": "10.0.0.5",
	"metadata.example.com": "169.254.169.254",
	"loopback.example.com": "127.0.0.1",
};
const f = merchantFixture({
	connectionValidation: createConnectionValidation({
		destinationDependencies: {
			lookup: async (hostname) => {
				const address = resolved[hostname];
				if (!address) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
				return [{ address, family: 4 }];
			},
		},
	}),
	environmentBilling: stubEnvironmentBilling(() => f.sql),
});
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
const scope: MerchantScope = {
	kind: "merchant",
	organizationSlug: "acme",
	projectKey: "example",
	environment: "sandbox",
};

describe("projection receiver validation", () => {
	it("answers a non-public or unresolvable receiver with 422, not 503", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const answers = [];
		for (const hostname of [...Object.keys(resolved), "missing.example.com"]) {
			const draft = await browser.json<{ draftId: string }>(
				"/api/platform/connections/projection/drafts",
				{
					scope,
					expectedRevision: 0,
					settings: { projectionUrl: `https://${hostname}/billing` },
					secrets: {},
				},
			);
			const response = await browser.request("/api/platform/connections/projection/validate", {
				scope,
				draftId: draft.draftId,
			});
			answers.push({ status: response.status, error: (await response.json()).error });
		}
		for (const answer of answers)
			expect(answer).toMatchObject({
				status: 422,
				error: { code: "PROJECTION_RECEIVER_UNREACHABLE", message: answers[0]?.error.message },
			});
		expect(
			await f.sql`SELECT id FROM platform_connection_versions WHERE validated_at IS NOT NULL`,
		).toHaveLength(0);
	});
});
