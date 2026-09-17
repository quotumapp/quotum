import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "../../src/billing/errors";
import { CatalogControlPlane } from "../../src/catalog/control-plane";
import type {
	CatalogFeatureIntent,
	CatalogIntent,
	CatalogProviderBindingIntent,
} from "../../src/catalog/types";

const feature: CatalogFeatureIntent = {
	key: "credits",
	name: "Credits",
	kind: "metered",
	meterKind: "consumable",
	unit: "credit",
	creditScale: 0,
	filterDimensions: [],
};

/** Normalization runs before the control plane touches its database. */
async function previewError(catalog: Partial<CatalogIntent>): Promise<unknown> {
	const controlPlane = new CatalogControlPlane({} as never);
	try {
		await controlPlane.preview({} as never, {
			expectedRevision: null,
			actor: "test",
			catalog: { features: [feature], plans: [], topups: [], rateCards: [], ...catalog },
		});
	} catch (error) {
		return error;
	}
	throw new Error("Catalog preview unexpectedly passed normalization");
}

function planWith(binding: CatalogProviderBindingIntent): Partial<CatalogIntent> {
	return { plans: [{ providerBindings: [binding], items: [] } as never] };
}

describe("catalog control plane provider bindings", () => {
	it("rejects a binding outside its provider's declared channel with the same message", async () => {
		const cases = [
			["apple", "web", "apple catalog bindings must use the ios channel"],
			["google", "ios", "google catalog bindings must use the android channel"],
			["stripe", "android", "stripe catalog bindings must use the web channel"],
		] as const;
		for (const [provider, channel, message] of cases) {
			const error = await previewError(planWith({ provider, channel, productKey: "pro" }));
			expect(error).toBeInstanceOf(InvalidRequestError);
			expect((error as InvalidRequestError).code).toBe("INVALID_REQUEST");
			expect((error as InvalidRequestError).message).toBe(message);
		}
	});

	it("accepts each admitted provider's declared channel", async () => {
		for (const [provider, channel] of [
			["apple", "ios"],
			["google", "android"],
			["stripe", "web"],
		] as const) {
			const error = await previewError(planWith({ provider, channel, productKey: "pro" }));
			expect((error as Error).message).not.toContain("catalog bindings must use");
		}
	});

	it("never admits a planned provider through its declared channel", async () => {
		const error = await previewError(
			planWith({ provider: "paddle" as never, channel: "web", productKey: "pro" }),
		);
		expect(error).toBeInstanceOf(InvalidRequestError);
		expect((error as InvalidRequestError).message).toBe(
			"paddle catalog bindings must use the undefined channel",
		);
	});

	it("checks top-up bindings the same way", async () => {
		const error = await previewError({
			topups: [
				{
					key: "pack",
					featureKey: "credits",
					quantity: "10",
					expiresAfterSeconds: null,
					providerBindings: [{ provider: "google", channel: "web", productKey: "pack" }],
				},
			],
		});
		expect((error as InvalidRequestError).message).toBe(
			"google catalog bindings must use the android channel",
		);
	});
});
