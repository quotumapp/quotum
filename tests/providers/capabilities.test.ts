import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changeBillingPolicyFromStripe, stripeProrationBehaviors } from "../../src/billing/pricing";
import { subscriptionStatuses } from "../../src/billing/types";
import type {
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
} from "../../src/catalog/types";
import {
	admittedProviders,
	bindingImplementsCatalogTarget,
	type CatalogCapabilityTarget,
	catalogConstructOperations,
	commercialActionOperations,
	commercialPreviewProvider,
	implementsOperation,
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
	providerCapabilityDeclaration,
	providerCapabilityDeclarations,
	providersImplementing,
	purchaseActionFor,
	requiredOperationsFor,
} from "../../src/providers/capabilities";
import { stripeCapabilities } from "../../src/providers/stripe/capabilities";
import {
	billingProviders,
	type DeclaredProvider,
	declaredProviders,
	type OperationSupport,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	plannedProviders,
	providerOperations,
	validateDeclaration,
} from "../../src/shared/provider-capabilities";

const repositoryRoot = join(import.meta.dir, "..", "..");

/** The channel each provider's catalog bindings must use (src/catalog/control-plane.ts). */
const controlPlaneChannels = {
	apple: "ios",
	google: "android",
	stripe: "web",
	paddle: "web",
} as const;

function supportEntries(
	declaration: ProviderCapabilityDeclaration,
): Array<[ProviderOperation, OperationSupport]> {
	return providerOperations.map((operation) => [operation, declaration.operations[operation]]);
}

function everySupport(): Array<
	[ProviderCapabilityDeclaration, ProviderOperation, OperationSupport]
> {
	return providerCapabilityDeclarations.flatMap((declaration) =>
		supportEntries(declaration).map(
			([operation, support]) =>
				[declaration, operation, support] as [
					ProviderCapabilityDeclaration,
					ProviderOperation,
					OperationSupport,
				],
		),
	);
}

function capabilityTag(operation: ProviderOperation): RegExp {
	return new RegExp(`^\\s*// capability: ${operation.replaceAll(".", "\\.")}\\s*$`, "m");
}

/** The source of each test a capability tag annotates, up to the start of the next test. */
function taggedTestBlocks(source: string, operation: ProviderOperation): string[] {
	const lines = source.split("\n");
	const tag = new RegExp(capabilityTag(operation).source);
	const testStart = /^\s*(it|test)(\.each\(.*\))?\(/;
	const blocks: string[] = [];
	lines.forEach((line, index) => {
		if (!tag.test(line)) return;
		const start = lines.findIndex((candidate, at) => at > index && testStart.test(candidate));
		if (start === -1) return;
		const next = lines.findIndex((candidate, at) => at > start && testStart.test(candidate));
		blocks.push(lines.slice(start, next === -1 ? undefined : next).join("\n"));
	});
	return blocks;
}

describe("provider capability declarations", () => {
	it("declares every provider once, in contract order", () => {
		expect(providerCapabilityDeclarations.map(({ provider }) => provider)).toEqual([
			...declaredProviders,
		]);
		expect([...providerCapabilityCatalog.keys()]).toEqual([...declaredProviders]);
		for (const declaration of providerCapabilityDeclarations) {
			expect(providerCapabilityDeclaration(declaration.provider)).toBe(declaration);
		}
		expect(providerCapabilityDeclaration("stripe")).toBe(stripeCapabilities);
	});

	it("passes declaration validation", () => {
		for (const declaration of providerCapabilityDeclarations) {
			expect({ provider: declaration.provider, issues: validateDeclaration(declaration) }).toEqual({
				provider: declaration.provider,
				issues: [],
			});
		}
	});

	it("cites existing tests tagged with each verified or conditional operation", () => {
		const missing: string[] = [];
		for (const [declaration, operation, support] of everySupport()) {
			const verification = support.verification;
			if (verification.status !== "verified" && verification.status !== "conditional") continue;
			expect(verification.evidence.tests.length).toBeGreaterThan(0);
			for (const path of verification.evidence.tests) {
				const label = `${declaration.provider} ${operation} ${path}`;
				if (!/^tests\/.+\.test\.ts$/.test(path)) {
					missing.push(`${label}: not a repository test path`);
					continue;
				}
				const file = join(repositoryRoot, path);
				if (!existsSync(file)) {
					missing.push(`${label}: file does not exist`);
					continue;
				}
				if (!capabilityTag(operation).test(readFileSync(file, "utf8"))) {
					missing.push(`${label}: missing // capability: ${operation}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("cites period-end change evidence whose tagged tests use a period-end change", () => {
		const blocks: string[] = [];
		for (const declaration of providerCapabilityDeclarations) {
			const support = declaration.operations["subscription.change.period_end"];
			const verification = support.verification;
			if (verification.status !== "verified" && verification.status !== "conditional") continue;
			for (const path of verification.evidence.tests) {
				const source = readFileSync(join(repositoryRoot, path), "utf8");
				for (const block of taggedTestBlocks(source, "subscription.change.period_end")) {
					blocks.push(`${declaration.provider} ${path}: ${block.includes("period_end")}`);
				}
			}
		}
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks.filter((block) => block.endsWith("false"))).toEqual([]);
	});

	it("admits exactly the billing providers", () => {
		expect(admittedProviders()).toEqual([...billingProviders]);
		for (const provider of billingProviders) {
			expect(providerCapabilityDeclaration(provider).availability).toBe("available");
		}
	});

	it("keeps planned providers out of the runtime provider list", () => {
		const planned = providerCapabilityDeclarations
			.filter(({ availability }) => availability === "planned")
			.map(({ provider }) => provider);

		expect(planned).toEqual([...plannedProviders]);
		for (const provider of planned) {
			expect((billingProviders as readonly string[]).includes(provider)).toBe(false);
			expect((admittedProviders() as string[]).includes(provider)).toBe(false);
		}
	});

	it("never marks a condition-bearing entry verified", () => {
		const verifiedWithConditions = everySupport()
			.filter(
				([, , support]) =>
					support.conditions.length > 0 && support.verification.status === "verified",
			)
			.map(([declaration, operation]) => `${declaration.provider} ${operation}`);

		expect(verifiedWithConditions).toEqual([]);
	});

	it("cites no conformance scenarios before the suite exists", () => {
		const withScenarios = everySupport()
			.filter(([, , support]) => (support.verification.evidence?.scenarios.length ?? 0) > 0)
			.map(([declaration, operation]) => `${declaration.provider} ${operation}`);

		expect(withScenarios).toEqual([]);
	});

	it("cites no assessment questions for available providers", () => {
		const withQuestions = everySupport()
			.filter(
				([declaration, , support]) =>
					declaration.availability === "available" &&
					(support.verification.evidence?.questions.length ?? 0) > 0,
			)
			.map(([declaration, operation]) => `${declaration.provider} ${operation}`);

		expect(withQuestions).toEqual([]);
	});

	it("tracks or blocks every planned entry of an available provider", () => {
		const untracked = everySupport()
			.filter(
				([declaration, , support]) =>
					declaration.availability === "available" &&
					support.verification.status === "planned" &&
					support.verification.trackedBy === undefined &&
					support.verification.blockedBy === undefined,
			)
			.map(([declaration, operation]) => `${declaration.provider} ${operation}`);

		expect(untracked).toEqual([]);
	});

	it("uses the control-plane channel and the platform connection kind of each provider", () => {
		expect(
			Object.fromEntries(
				providerCapabilityDeclarations.map(({ provider, channel }) => [provider, channel]),
			),
		).toEqual(controlPlaneChannels);
		expect(
			Object.fromEntries(
				providerCapabilityDeclarations.map(({ provider, connectionKind }) => [
					provider,
					connectionKind,
				]),
			),
		).toEqual({ apple: "apple", google: "google", stripe: "stripe", paddle: "paddle" });
	});

	it("allows only billing subscription statuses in subscription state conditions", () => {
		const unknownStatuses = everySupport().flatMap(([declaration, operation, support]) =>
			support.conditions.flatMap((condition) =>
				condition.kind === "subscription_state"
					? condition.allowed
							.filter((status) => !(subscriptionStatuses as readonly string[]).includes(status))
							.map((status) => `${declaration.provider} ${operation} ${status}`)
					: [],
			),
		);

		expect(unknownStatuses).toEqual([]);
	});

	it("declares the change billing policies Stripe proration behaviors express", () => {
		expect(stripeCapabilities.changeBillingPolicies).toEqual(
			stripeProrationBehaviors.map(changeBillingPolicyFromStripe),
		);
	});
});

function price(pricingModel?: CatalogPriceIntent["pricingModel"]): CatalogPriceIntent {
	return {
		key: "price",
		currency: "USD",
		unitAmountMinor: 100,
		billingUnits: "1",
		billingInterval: "month",
		minimumQuantity: 1,
		maximumQuantity: null,
		taxBehavior: "exclusive",
		...(pricingModel === undefined ? {} : { pricingModel }),
		providerBindings: [],
	};
}

function item(itemKind: CatalogPlanItemIntent["itemKind"]): CatalogPlanItemIntent {
	return {
		featureKey: itemKind,
		itemKind,
		quantity: itemKind === "access" ? null : "1",
		resetInterval: itemKind === "meter_limit" ? "month" : null,
		expiresAfterSeconds: null,
		overagePolicy: itemKind === "meter_limit" ? "allowed" : "blocked",
	};
}

type PricedPlan = Pick<CatalogPlanIntent, "basePrice" | "items">;

const seatItem: CatalogPlanItemIntent = { ...item("licensed_quantity"), price: price() };
const tieredOverageItem: CatalogPlanItemIntent = {
	...item("meter_limit"),
	price: price("graduated"),
};
const accessItem = item("access");
const seatsOnlyPlan: PricedPlan = { basePrice: null, items: [seatItem] };
const baseOnlyPlan: PricedPlan = { basePrice: price(), items: [item("allocation")] };
const hybridPlan: PricedPlan = {
	basePrice: price(),
	items: [seatItem, tieredOverageItem, accessItem],
};

describe("catalog capability requirements", () => {
	it("maps product types to catalog product operations", () => {
		expect(requiredOperationsFor({ kind: "product", productType: "subscription" })).toEqual([
			"catalog.product.subscription",
		]);
		expect(requiredOperationsFor({ kind: "product", productType: "consumable" })).toEqual([
			"catalog.product.consumable",
		]);
		expect(requiredOperationsFor({ kind: "product", productType: "non_consumable" })).toEqual([
			"catalog.product.non_consumable",
		]);
	});

	it("maps plan trials and add-ons", () => {
		expect(requiredOperationsFor({ kind: "plan", plan: { trialDays: null } })).toEqual([
			"catalog.product.subscription",
		]);
		expect(requiredOperationsFor({ kind: "plan", plan: { kind: "base", trialDays: 0 } })).toEqual([
			"catalog.product.subscription",
		]);
		expect(requiredOperationsFor({ kind: "plan", plan: { kind: "addon", trialDays: 14 } })).toEqual(
			["catalog.product.subscription", "catalog.trial", "catalog.addon"],
		);
	});

	it("maps top-ups to consumable products", () => {
		expect(requiredOperationsFor({ kind: "topup" })).toEqual([
			"catalog.product.consumable",
			"catalog.topup",
		]);
	});

	it("maps price components by pricing model, item kind and plan composition", () => {
		expect(requiredOperationsFor({ kind: "price", plan: baseOnlyPlan, item: null })).toEqual([
			"catalog.product.subscription",
			"catalog.price.flat",
		]);
		expect(requiredOperationsFor({ kind: "price", plan: seatsOnlyPlan, item: seatItem })).toEqual([
			"catalog.product.subscription",
			"catalog.price.flat",
			"catalog.price.licensed",
		]);
		expect(requiredOperationsFor({ kind: "price", plan: hybridPlan, item: null })).toEqual([
			"catalog.product.subscription",
			"catalog.price.flat",
			"catalog.price.hybrid",
		]);
		expect(
			requiredOperationsFor({ kind: "price", plan: hybridPlan, item: tieredOverageItem }),
		).toEqual([
			"catalog.product.subscription",
			"catalog.price.tiered",
			"catalog.price.hybrid",
			"catalog.price.postpaid_usage",
		]);
		expect(
			requiredOperationsFor({
				kind: "price",
				plan: { basePrice: price("volume"), items: [] },
				item: null,
			}),
		).toEqual(["catalog.product.subscription", "catalog.price.tiered"]);
		expect(
			requiredOperationsFor({
				kind: "price",
				plan: { basePrice: price("flat"), items: [] },
				item: null,
			}),
		).toEqual(["catalog.product.subscription", "catalog.price.flat"]);
	});

	it("rejects a price target without a price component", () => {
		expect(() =>
			requiredOperationsFor({ kind: "price", plan: { basePrice: null, items: [] }, item: null }),
		).toThrow("A price capability target requires a price component");
		expect(() =>
			requiredOperationsFor({ kind: "price", plan: hybridPlan, item: accessItem }),
		).toThrow("A price capability target requires a price component");
	});

	it("finds non-Stripe bindings incompatible for exactly the constructs the control plane rejects", () => {
		const corpus: Array<{ name: string; target: CatalogCapabilityTarget }> = [
			{ name: "subscription product", target: { kind: "product", productType: "subscription" } },
			{ name: "consumable product", target: { kind: "product", productType: "consumable" } },
			{ name: "base plan", target: { kind: "plan", plan: { kind: "base", trialDays: null } } },
			{ name: "plan without trial days", target: { kind: "plan", plan: { trialDays: 0 } } },
			{ name: "trial plan", target: { kind: "plan", plan: { kind: "base", trialDays: 7 } } },
			{ name: "add-on plan", target: { kind: "plan", plan: { kind: "addon", trialDays: null } } },
			{ name: "top-up", target: { kind: "topup" } },
			{ name: "flat base price", target: { kind: "price", plan: baseOnlyPlan, item: null } },
			{
				name: "licensed seat price",
				target: { kind: "price", plan: seatsOnlyPlan, item: seatItem },
			},
			{
				name: "tiered overage price",
				target: { kind: "price", plan: hybridPlan, item: tieredOverageItem },
			},
			{ name: "hybrid base price", target: { kind: "price", plan: hybridPlan, item: null } },
		];
		// The string rules src/catalog/control-plane.ts applied before it consulted declarations:
		// trials and add-ons required every plan binding to be Stripe, and explicit price components
		// required Stripe price bindings. tests/catalog/provider-gates-equivalence.test.ts pins the
		// resulting messages and their order through the control plane itself.
		const rejectedForNonStripe = ({ target }: (typeof corpus)[number]) =>
			(target.kind === "plan" &&
				((target.plan.trialDays ?? 0) > 0 || target.plan.kind === "addon")) ||
			target.kind === "price";

		for (const provider of admittedProviders()) {
			const declaration = providerCapabilityDeclaration(provider);
			const outcomes = corpus.map((entry) => ({
				name: entry.name,
				compatible: catalogConstructOperations(entry.target).every((operation) =>
					implementsOperation(declaration, operation),
				),
				// The control plane asks through this helper, so the two must never disagree.
				throughBinding: bindingImplementsCatalogTarget(
					providerCapabilityCatalog,
					provider,
					entry.target,
				),
			}));

			expect({ provider, outcomes }).toEqual({
				provider,
				outcomes: corpus.map((entry) => ({
					name: entry.name,
					compatible: provider === "stripe" || !rejectedForNonStripe(entry),
					throughBinding: provider === "stripe" || !rejectedForNonStripe(entry),
				})),
			});
		}
	});
});

/** One provider's support for one operation replaced, leaving every other declaration alone. */
function catalogDeclaring(
	provider: DeclaredProvider,
	patch: Partial<ProviderCapabilityDeclaration>,
): ProviderCapabilityLookup {
	return new Map(providerCapabilityCatalog).set(provider, {
		...providerCapabilityDeclaration(provider),
		...patch,
	});
}

function withSupport(
	provider: DeclaredProvider,
	operation: ProviderOperation,
	support: OperationSupport,
): ProviderCapabilityLookup {
	const declaration = providerCapabilityDeclaration(provider);
	return catalogDeclaring(provider, {
		operations: { ...declaration.operations, [operation]: support },
	});
}

const nativelyVerified: OperationSupport = {
	level: "native",
	verification: {
		status: "verified",
		verifiedOn: "2026-09-17",
		evidence: { tests: [], scenarios: [], questions: [] },
	},
	conditions: [],
};

const unsupported: OperationSupport = {
	level: "unsupported",
	verification: { status: "not_applicable" },
	conditions: [],
};

describe("declaration helpers the runtime gates read", () => {
	it("calls an operation implemented only when its provider and implementation layers pass", () => {
		expect(implementsOperation(stripeCapabilities, "checkout.plan")).toBe(true);
		const apple = providerCapabilityDeclaration("apple");
		expect(implementsOperation(apple, "topup.customer_initiated")).toBe(true);
		// Provider-managed and not-evaluated both block the implementation layer.
		expect(implementsOperation(apple, "catalog.trial")).toBe(false);
		expect(implementsOperation(apple, "catalog.price.flat")).toBe(false);
		// A planned declaration is blocked one layer earlier, whatever it says per operation.
		expect(implementsOperation(providerCapabilityDeclaration("paddle"), "checkout.hosted")).toBe(
			false,
		);
		// A hand-built declaration must still declare every operation; a gap throws rather than
		// silently reading as unimplemented.
		expect(() =>
			implementsOperation({ ...apple, operations: {} as never }, "catalog.topup"),
		).toThrow("Capability declaration for apple does not declare catalog.topup");
	});

	it("lists the admitted providers implementing an operation, in contract order", () => {
		expect(providersImplementing("topup.customer_initiated")).toEqual([
			"apple",
			"google",
			"stripe",
		]);
		expect(providersImplementing("topup.automatic")).toEqual(["stripe"]);
		expect(providersImplementing("checkout.plan")).toEqual(["stripe"]);
		for (const operation of providerOperations) {
			expect(providersImplementing(operation)).not.toContain("paddle");
		}
	});

	it("honours an injected lookup, including a declaration that is no longer available", () => {
		expect(
			providersImplementing(
				"topup.automatic",
				withSupport("apple", "topup.automatic", nativelyVerified),
			),
		).toEqual(["apple", "stripe"]);
		expect(
			providersImplementing(
				"topup.automatic",
				catalogDeclaring("stripe", { availability: "planned" }),
			),
		).toEqual([]);
	});

	it("drops product types from the operations a catalog construct needs", () => {
		expect(catalogConstructOperations({ kind: "product", productType: "consumable" })).toEqual([]);
		expect(catalogConstructOperations({ kind: "plan", plan: { trialDays: null } })).toEqual([]);
		expect(
			catalogConstructOperations({ kind: "plan", plan: { kind: "addon", trialDays: 14 } }),
		).toEqual(["catalog.trial", "catalog.addon"]);
		expect(catalogConstructOperations({ kind: "topup" })).toEqual(["catalog.topup"]);
		expect(
			catalogConstructOperations({ kind: "price", plan: seatsOnlyPlan, item: seatItem }),
		).toEqual(["catalog.price.flat", "catalog.price.licensed"]);
	});

	it("never admits a binding whose provider has no declaration", () => {
		const trialPlan: CatalogCapabilityTarget = { kind: "plan", plan: { trialDays: 7 } };
		expect(bindingImplementsCatalogTarget(providerCapabilityCatalog, "stripe", trialPlan)).toBe(
			true,
		);
		expect(bindingImplementsCatalogTarget(providerCapabilityCatalog, "apple", trialPlan)).toBe(
			false,
		);
		expect(bindingImplementsCatalogTarget(providerCapabilityCatalog, "paddle", trialPlan)).toBe(
			false,
		);
		expect(bindingImplementsCatalogTarget(providerCapabilityCatalog, "quotum", trialPlan)).toBe(
			false,
		);
		expect(bindingImplementsCatalogTarget(new Map(), "stripe", trialPlan)).toBe(false);
	});

	it("never admits a planned declaration, even for a target that requires no operation", () => {
		const plainPlan: CatalogCapabilityTarget = { kind: "plan", plan: { trialDays: null } };
		expect(catalogConstructOperations(plainPlan)).toEqual([]);
		expect(bindingImplementsCatalogTarget(providerCapabilityCatalog, "stripe", plainPlan)).toBe(
			true,
		);
		expect(bindingImplementsCatalogTarget(providerCapabilityCatalog, "paddle", plainPlan)).toBe(
			false,
		);
	});

	it("asks every admitted provider for a customer-initiated top-up purchase", () => {
		for (const provider of admittedProviders()) {
			expect(purchaseActionFor(provider)).toBe("purchase_required");
		}
		expect(
			purchaseActionFor("apple", withSupport("apple", "topup.customer_initiated", unsupported)),
		).toBe("provider_action_required");
		expect(purchaseActionFor("apple", new Map())).toBe("provider_action_required");
	});

	it("reports the commercial preview provider only for an admitted implementer", () => {
		// Pinned literally rather than read back from the map: Stripe implements both checkout
		// operations, so swapping the pair stays invisible until a provider builds only one.
		const expected = {
			checkout_plan: "checkout.plan",
			checkout_product: "checkout.hosted",
			subscription_change: "subscription.change.preview",
		} as const satisfies typeof commercialActionOperations;
		expect(commercialActionOperations).toEqual(expected);

		for (const [action, operation] of Object.entries(expected) as Array<
			[keyof typeof expected, ProviderOperation]
		>) {
			expect(commercialPreviewProvider(stripeCapabilities, action)).toBe("stripe");
			expect(() =>
				commercialPreviewProvider(providerCapabilityDeclaration("apple"), action),
			).toThrow(`Provider apple does not implement ${operation}`);
			expect(() =>
				commercialPreviewProvider(providerCapabilityDeclaration("paddle"), action),
			).toThrow(`Provider paddle is not admitted for ${operation}`);
		}
	});

	it("leaves Stripe as the only provider behind the commercial wire literal", () => {
		const operations = Object.values(commercialActionOperations);
		expect(
			admittedProviders().filter((provider) =>
				operations.every((operation) =>
					implementsOperation(providerCapabilityDeclaration(provider), operation),
				),
			),
		).toEqual(["stripe"]);
	});
});
