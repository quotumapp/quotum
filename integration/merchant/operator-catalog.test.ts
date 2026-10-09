import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Stripe from "stripe";
import { runCredentialsCommand } from "../../src/composition/cli/credentials";
import { runEnvironmentsCommand } from "../../src/composition/cli/environments";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import { MerchantBrowser, merchantFixture } from "./fixture";
import {
	connectProductionInstance,
	operatorEnv as env,
	lifecycleStatusOf,
	runOperator,
	runOperatorCatalog,
	seedOperatorOrganization,
	withScratchDirectory,
} from "./operator-fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const stripeBinding = (productKey: string) => ({ productKey, provider: "stripe", channel: "web" });
const feature = {
	key: "ai_credits",
	name: "AI credits",
	kind: "metered",
	meterKind: "consumable",
	unit: "credit",
	creditScale: 0,
	filterDimensions: [],
};
/** A catalog with nothing to bind, so it publishes without any provider product. */
const featuresOnly = { features: [feature], plans: [], topups: [], rateCards: [] };
/** One plan sold through Stripe, which publishes only once `pro_monthly` is adopted. */
const stripePlan = {
	features: [feature],
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
				providerBindings: [stripeBinding("pro_monthly")],
			},
			providerBindings: [stripeBinding("pro_monthly")],
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
};
const adoption = {
	productKey: "pro_monthly",
	name: "Pro monthly",
	kind: "subscription",
	entitlementKey: "pro",
	credits: 1000,
	externalProductId: "prod_pro",
	externalPriceId: "price_pro",
};
/** The one Stripe product and price the adoption looks up, live mode like a production instance. */
const fakeStripe = () =>
	({
		prices: {
			retrieve: async () => ({
				id: adoption.externalPriceId,
				product: adoption.externalProductId,
				active: true,
				livemode: true,
				billing_scheme: "per_unit",
				unit_amount: 2000,
				currency: "usd",
				type: "recurring",
				recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
			}),
		},
		products: {
			retrieve: async () => ({ id: adoption.externalProductId, active: true, livemode: true }),
		},
	}) as unknown as Stripe;

async function writeCatalog(directory: string, catalog: unknown, name = "catalog.js") {
	const file = join(directory, name);
	await writeFile(file, `export const catalog = ${JSON.stringify(catalog)};\n`);
	return file;
}

async function writeAdoption(directory: string) {
	const file = join(directory, "binding.json");
	await writeFile(file, JSON.stringify(adoption));
	return file;
}

const publishedRevision = async () =>
	(
		await f.sql<
			{ revision: string | null }[]
		>`SELECT published_catalog_revision_id::text AS revision FROM projects WHERE key='alpha'`
	)[0]?.revision ?? null;

describe("operator catalog commands with --instance", () => {
	it("reads, previews and publishes to an inactive environment without a project key", async () => {
		await seedOperatorOrganization(f, "inactive");
		await withScratchDirectory(async (directory) => {
			const file = await writeCatalog(directory, featuresOnly);
			const direct = (...args: string[]) => runOperatorCatalog([...args, "--instance", "alpha"]);

			const empty = await direct("status");
			expect(empty.code).toBe(0);
			expect(empty.json).toMatchObject({ revision: null, intentHash: null, catalog: null });

			const diff = await direct("diff", file);
			expect(diff.code).toBe(0);
			expect(diff.json).toMatchObject({ changed: true, currentRevision: null, nextRevision: 1 });
			expect(await publishedRevision()).toBeNull();

			const pushed = await direct("push", file);
			expect(pushed.code).toBe(0);
			expect(pushed.json).toMatchObject({ revision: 1 });
			expect(await publishedRevision()).not.toBeNull();
			expect(await lifecycleStatusOf(f, "alpha")).toBe("inactive");
			// The revision names the operator, as the console's names the member.
			expect(await f.sql`SELECT created_by FROM catalog_revisions WHERE revision=1`).toEqual([
				{ created_by: "operator:ops-runbook" },
			]);

			const status = await direct("status");
			expect(status.json).toMatchObject({ revision: 1 });
			// An unchanged catalog is left alone, as over HTTP.
			const again = await direct("push", file);
			expect(again.json).toMatchObject({ changed: false, published: false, revision: 1 });
		});
	});

	it("takes the operator from --actor, and a change must name one", async () => {
		await seedOperatorOrganization(f, "inactive");
		await withScratchDirectory(async (directory) => {
			const file = await writeCatalog(directory, featuresOnly);
			const noOperator = { ...env, QUOTUM_ACTOR: undefined };
			const refused = await runOperatorCatalog(
				["push", file, "--instance", "alpha"],
				{},
				noOperator,
			);
			expect(refused.code).toBe(64);
			expect(refused.stderr).toContain("Name the operator with --actor");
			expect(await publishedRevision()).toBeNull();
			const named = await runOperatorCatalog(
				["push", file, "--instance", "alpha", "--actor", "release-bot"],
				{},
				noOperator,
			);
			expect(named.code).toBe(0);
			expect(await f.sql`SELECT created_by FROM catalog_revisions WHERE revision=1`).toEqual([
				{ created_by: "operator:release-bot" },
			]);
			// A read needs no name.
			expect(
				(await runOperatorCatalog(["status", "--instance", "alpha"], {}, noOperator)).code,
			).toBe(0);
		});
	});

	it("works on an active environment and on sandbox as well", async () => {
		await seedOperatorOrganization(f, "active");
		await withScratchDirectory(async (directory) => {
			const file = await writeCatalog(directory, featuresOnly);
			for (const instance of ["alpha", "alpha-sandbox"]) {
				const pushed = await runOperatorCatalog(["push", file, "--instance", instance]);
				expect(pushed.code, instance).toBe(0);
				expect(pushed.json, instance).toMatchObject({ revision: 1 });
			}
		});
	});

	it("adopts a Stripe product through the instance's own connection, then lists it", async () => {
		await seedOperatorOrganization(f, "inactive");
		await withScratchDirectory(async (directory) => {
			const binding = await writeAdoption(directory);
			// Adoption reads the Stripe connection's secret key, so it needs a connection first.
			const missing = await runOperatorCatalog(
				["bindings", "adopt", binding, "--instance", "alpha"],
				{
					stripeClient: fakeStripe,
				},
			);
			expect(missing.code).toBe(1);
			expect(missing.stderr).toContain("CONNECTION_UNAVAILABLE");

			await connectProductionInstance(directory);
			const adopted = await runOperatorCatalog(
				["bindings", "adopt", binding, "--instance", "alpha"],
				{
					stripeClient: fakeStripe,
				},
			);
			expect(adopted.code).toBe(0);
			expect(adopted.json).toMatchObject({
				productKey: "pro_monthly",
				externalProductId: "prod_pro",
				externalPriceId: "price_pro",
				active: true,
			});
			// A retry of the same file replays instead of failing.
			const retry = await runOperatorCatalog(
				["bindings", "adopt", binding, "--instance", "alpha"],
				{
					stripeClient: fakeStripe,
				},
			);
			expect(retry.json).toEqual(adopted.json);
			const listed = await runOperatorCatalog(["bindings", "list", "--instance", "alpha"]);
			// The list is a JSON array; the shared result type holds objects.
			expect(listed.json as unknown).toEqual([adopted.json]);
			// The retry's request key derives from the file, so it replayed the one receipt.
			expect(await f.sql`SELECT actor FROM catalog_binding_adoptions`).toEqual([
				{ actor: "operator:ops-runbook" },
			]);
		});
	});

	it("prepares an inactive Stripe environment from the CLI and activates it", async () => {
		await seedOperatorOrganization(f, "inactive");
		const resolver = new PostgresProjectInstanceContextResolver(f.client);
		await withScratchDirectory(async (directory) => {
			await connectProductionInstance(directory);
			const file = await writeCatalog(directory, stripePlan);
			const direct = (argv: string[]) =>
				runOperatorCatalog([...argv, "--instance", "alpha"], { stripeClient: fakeStripe });

			// The plan names a binding nobody has adopted, so it cannot publish yet.
			const unbound = await direct(["push", file]);
			expect(unbound.code).toBe(1);
			expect(unbound.stderr).toContain("PROVIDER_BINDING_NOT_READY");
			expect(await publishedRevision()).toBeNull();

			expect((await direct(["bindings", "adopt", await writeAdoption(directory)])).code).toBe(0);
			expect((await direct(["push", file])).json).toMatchObject({ revision: 1 });

			// With the real billing reads, nothing stubbed: the published catalog makes it ready.
			const readiness = await runOperator(runEnvironmentsCommand, ["readiness", "alpha"]);
			expect(readiness.code).toBe(0);
			expect(readiness.json).toMatchObject({
				ready: true,
				blockers: [],
				lifecycleStatus: "inactive",
			});

			const out = join(directory, "production-key.json");
			const activated = await runOperator(runEnvironmentsCommand, [
				"activate",
				"alpha",
				"--credentials-out",
				out,
			]);
			expect(activated.code).toBe(0);
			expect(activated.json).toMatchObject({ active: true, credentialDisclosed: true });
			expect((await stat(out)).mode & 0o777).toBe(0o600);
			const token = String(JSON.parse(await readFile(out, "utf8")).credentials[0].credential);
			expect((await resolver.resolveCredential(token)).kind).toBe("resolved");
			expect(await lifecycleStatusOf(f, "alpha")).toBe("active");
			expect((await runOperator(runCredentialsCommand, ["status", "alpha"])).json).toMatchObject({
				full: { live: true },
			});
		});
	});

	it("changes an organization its members manage only with a stated reason", async () => {
		await seedOperatorOrganization(f, "inactive");
		await new MerchantBrowser(f).signup();
		await f.sql`
			INSERT INTO platform_memberships(organization_id, principal_id, role)
			SELECT o.id, p.id, 'Owner' FROM platform_organizations o, platform_principals p
			WHERE o.slug='ops'
		`;
		const merchantMode = { ...env, QUOTUM_CONSOLE_ENABLED: "true" };
		await withScratchDirectory(async (directory) => {
			const file = await writeCatalog(directory, featuresOnly);
			// Reading needs no reason.
			expect(
				(await runOperatorCatalog(["status", "--instance", "alpha"], {}, merchantMode)).code,
			).toBe(0);
			for (const command of [
				["diff", file],
				["push", file],
			]) {
				const refused = await runOperatorCatalog(
					[...command, "--instance", "alpha"],
					{},
					merchantMode,
				);
				expect(refused.code, command.join(" ")).toBe(1);
				expect(refused.stderr).toContain("This organization has members");
				expect(refused.stderr).toContain("--member-override-reason");
			}
			expect(await publishedRevision()).toBeNull();
			const allowed = await runOperatorCatalog(
				[
					"push",
					file,
					"--instance",
					"alpha",
					"--member-override-reason",
					"owner asked us to publish",
				],
				{},
				merchantMode,
			);
			expect(allowed.code).toBe(0);
			expect(allowed.json).toMatchObject({ revision: 1 });
		});
	});

	it("rejects an unknown instance", async () => {
		await seedOperatorOrganization(f, "inactive");
		const unknown = await runOperatorCatalog(["status", "--instance", "missing"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("was not found");
	});
});
