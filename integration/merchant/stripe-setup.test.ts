import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import Stripe from "stripe";
import { openOperatorContext } from "../../src/composition/cli/operator-context";
import { runStripeSetupCommand } from "../../src/composition/cli/stripe-setup";
import { createConnectionEventApp } from "../../src/composition/connection-events";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import { validateStripeAccess } from "../../src/composition/stripe-connection-validation";
import { stripeSetupProbeObserver } from "../../src/composition/stripe-setup/probe";
import { StripeSetupService } from "../../src/composition/stripe-setup/service";
import { closePool } from "../../src/db/client";
import { BillingRepository } from "../../src/db/repository";
import { ConnectionCipher, loadConnectionCipher } from "../../src/platform/connections/cipher";
import { StripeSetupStore } from "../../src/platform/connections/stripe-setup-store";
import { STRIPE_API_VERSION, StripeBillingClient } from "../../src/providers/stripe/client";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { SetupStripeTransport, setupManifest } from "../../tests/helpers/stripe-setup";
import { merchantFixture } from "./fixture";
import { operatorEnv, seedOperatorOrganization, withScratchDirectory } from "./operator-fixture";

const f = merchantFixture();
beforeEach(async () => {
	await f.reset();
	await seedOperatorOrganization(f);
});
afterAll(async () => {
	await f.sql.close();
	await closePool();
});

async function withSetup(
	production: boolean,
	work: (
		service: StripeSetupService,
		stripe: SetupStripeTransport,
		deliver: (tamper?: boolean) => Promise<void>,
	) => Promise<void>,
) {
	const stripe = new SetupStripeTransport(production);
	const context = await openOperatorContext(operatorEnv, {
		validator: {
			normalize: createConnectionValidation().normalize,
			validate: async (_kind, _environment, input) =>
				validateStripeAccess(stripe.client(input.secrets.secretKey ?? ""), { eventRead: true }),
		},
	});
	const service = new StripeSetupService({
		context,
		cipher: loadConnectionCipher(operatorEnv),
		actor: "setup-test",
		client: stripe.client,
	});
	const ingress = createConnectionEventApp(context.repository, {
		stripeHttpClient: stripe.httpClient,
	});
	const deliver = async (tamper = false) => {
		for (const delivery of stripe.deliveries.splice(0)) {
			const payload = JSON.stringify(delivery.event);
			const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
				payload,
				secret: tamper ? "whsec_wrong" : "whsec_setup",
			});
			if (delivery.url.includes("/connections/")) {
				const response = await ingress.handle(
					new Request(delivery.url, {
						method: "POST",
						headers: { "content-type": "application/json", "stripe-signature": signature },
						body: payload,
					}),
				);
				expect(response.status).toBe(tamper ? 400 : 200);
			} else {
				const target = await context.target(production ? "alpha" : "alpha-sandbox");
				const connection = await context.repository.active(target.instanceId, "stripe");
				if (!connection) throw new Error("Missing active connection");
				const config = {
					...setupManifest(production).settings,
					...stripe.credentials(),
					secretKey: stripe.credentials().runtimeKey,
					webhookSecret: "whsec_setup",
					apiVersion: STRIPE_API_VERSION,
				};
				const provider = new StripeBillingService({
					config,
					client: new StripeBillingClient(config, stripe.client(config.secretKey)),
					repository: new BillingRepository(context.billingDatabase).forProject(target.project),
					onVerifiedWebhook: (event) =>
						stripeSetupProbeObserver(
							service.store,
							context.repository,
							stripe.client,
						)(target.project, event),
				});
				if (tamper)
					await expect(
						provider.handleWebhook({ rawBody: payload, signatureHeader: signature }),
					).rejects.toThrow("signature");
				else
					expect(
						(await provider.handleWebhook({ rawBody: payload, signatureHeader: signature })).status,
					).toBe("ignored");
			}
		}
	};
	try {
		await work(service, stripe, deliver);
	} finally {
		await context.close();
	}
}

describe("durable Stripe setup", () => {
	it("runs prepare, read-only status and blocked apply through the CLI with redacted receipts", async () => {
		await withScratchDirectory(async (directory) => {
			const stripe = new SetupStripeTransport();
			const credentials = join(directory, "credentials.json");
			const manifest = join(directory, "manifest.json");
			await writeFile(credentials, JSON.stringify(stripe.credentials()), { mode: 0o600 });
			await writeFile(manifest, JSON.stringify(setupManifest()));
			const run = async (args: string[]) => {
				const out: string[] = [],
					err: string[] = [];
				const code = await runStripeSetupCommand(args, operatorEnv, {
					client: stripe.client,
					output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
				});
				return { code, out: out.join(""), err: err.join("") };
			};
			const prepared = await run(["prepare", manifest, "--credentials-file", credentials]);
			expect(prepared.code).toBe(0);
			const id = JSON.parse(prepared.out).setupId;
			expect((await run(["status", id])).code).toBe(0);
			expect((await run(["verify", id, "--credentials-file", credentials])).err).toContain(
				"setup_not_committed_use_apply",
			);
			stripe.deniedPath = "/v1/products";
			const blocked = await run(["apply", id, "--credentials-file", credentials]);
			expect(blocked.code).toBe(2);
			expect(blocked.out).toContain("product_read");
			expect(JSON.stringify(blocked)).not.toContain("rk_test_never_print");
		});
	});
	it("reports safe permission diagnostics and refuses to replace an existing connection", async () => {
		await withSetup(false, async (service, stripe) => {
			const target = await service.options.context.target("alpha-sandbox");
			const gate = service.options.context.gate(target, "setup-test");
			const draft = await service.options.context.lifecycle.draft(
				gate,
				"stripe",
				"existing-connection",
				{
					expectedRevision: 0,
					settings: setupManifest().settings,
					secrets: { secretKey: stripe.credentials().runtimeKey, webhookSecret: "whsec_existing" },
				},
			);
			await service.options.context.lifecycle.validate(gate, "stripe", draft.draftId);
			await service.options.context.lifecycle.commit(
				gate,
				"stripe",
				draft.draftId,
				"existing-commit",
			);
			await expect(service.prepare(setupManifest(), stripe.credentials())).rejects.toThrow(
				"existing_connection_replacement_not_supported",
			);
			expect(stripe.count("product")).toBe(0);
		});
	});
	it("keeps runtime permission failures actionable without exposing Stripe messages", async () => {
		await withSetup(false, async (service, stripe) => {
			const run = await service.prepare(setupManifest(), stripe.credentials());
			stripe.deniedPath = "/v1/products";
			const result = await service.apply(run.setupId, stripe.credentials());
			expect(result.reason).toBe("STRIPE_CONNECTION_INVALID");
			expect(result.checks).toMatchObject({ missingPermissions: ["product_read"] });
			expect(JSON.stringify(result)).not.toContain("rk_test_never_print");
			expect(stripe.count("product")).toBe(0);
			stripe.deniedPath = null;
			expect((await service.apply(run.setupId, stripe.credentials())).checks).toBeNull();
		});
	});
	it("reconciles expired idempotency receipts without creating duplicates, and refuses uncertain creates", async () => {
		await withSetup(false, async (service, stripe) => {
			const run = await service.prepare(setupManifest(), stripe.credentials());
			expect((await service.apply(run.setupId, stripe.credentials())).status).toBe(
				"awaiting_setup_event",
			);
			await f.sql`UPDATE platform_stripe_setup_steps SET result=NULL,created_at=now()-interval '25 hours' WHERE setup_id=${run.setupId} AND key='product:credits_10'`;
			stripe.receipts.clear();
			expect((await service.apply(run.setupId, stripe.credentials())).status).toBe(
				"awaiting_setup_event",
			);
			expect(stripe.count("product")).toBe(2);
			await f.sql`UPDATE platform_stripe_setup_steps SET result=NULL WHERE setup_id=${run.setupId} AND key='product:credits_10'`;
			for (const [id, item] of stripe.objects)
				if (
					(item.metadata as Record<string, string> | undefined)?.quotum_setup_step ===
					"product:credits_10"
				)
					stripe.objects.delete(id);
			expect((await service.apply(run.setupId, stripe.credentials())).reason).toBe(
				"uncertain_provider_write_requires_review",
			);
			expect(stripe.count("product")).toBe(1);
		});
	});
	it("recovers a one-time endpoint secret only from a protected supplied value and rotates pending secrets", async () => {
		await withSetup(false, async (service, stripe) => {
			const run = await service.prepare(setupManifest(), stripe.credentials());
			stripe.failAfterCreate = "webhook_endpoints";
			expect((await service.apply(run.setupId, stripe.credentials())).reason).toBe(
				"webhook_secret_unavailable_supply_from_dashboard",
			);
			expect(stripe.count("webhook_endpoint")).toBe(1);
			expect(
				(
					await service.apply(run.setupId, {
						...stripe.credentials(),
						webhookSecret: "whsec_setup",
					})
				).status,
			).toBe("awaiting_setup_event");
			const cipher = new ConnectionCipher(
				"next",
				new Map([
					["test", Buffer.alloc(32, 7)],
					["next", Buffer.alloc(32, 8)],
				]),
			);
			const rotated = new StripeSetupStore(service.options.context.sql, cipher);
			expect(await rotated.rotate()).toBe(1);
			expect(rotated.open(await rotated.get(run.setupId))).toBe("whsec_setup");
			expect(await rotated.rotate()).toBe(0);
		});
	});
	it("refreshes expired drafts while preserving resources, rejects bad final signatures, and recovers a committed publication", async () => {
		await withSetup(true, async (service, stripe, deliver) => {
			const run = await service.prepare(setupManifest(true), stripe.credentials());
			const first = await service.apply(run.setupId, stripe.credentials());
			stripe.deliveries.length = 0;
			await f.sql`UPDATE platform_connection_versions SET expires_at=now()-interval '1 minute' WHERE id=${first.draftId}`;
			const second = await service.apply(run.setupId, stripe.credentials());
			expect(second.draftId).not.toBe(first.draftId);
			expect(stripe.count("webhook_endpoint")).toBe(1);
			await deliver();
			expect((await service.apply(run.setupId, stripe.credentials())).status).toBe(
				"awaiting_delivery_event",
			);
			const pending = [...stripe.deliveries];
			await deliver(true);
			expect((await service.status(run.setupId)).deliveryVerifiedAt).toBeNull();
			for (const { event } of pending) stripe.objects.set(event.id, { ...event, livemode: false });
			stripe.deliveries.push(...pending);
			await deliver();
			expect((await service.status(run.setupId)).deliveryVerifiedAt).toBeNull();
			for (const { event } of pending) stripe.objects.set(event.id, event);
			stripe.deliveries.push(...pending);
			await deliver();
			const patch = service.store.patch.bind(service.store);
			let fail = true;
			service.store.patch = async (id, token, state) => {
				if (state.publishedRevision && fail) {
					fail = false;
					throw new Error("Lost publication response");
				}
				return patch(id, token, state);
			};
			expect((await service.apply(run.setupId, stripe.credentials())).status).toBe(
				"requires_review",
			);
			expect(await service.apply(run.setupId, stripe.credentials())).toMatchObject({
				status: "complete",
				catalogRevision: 1,
			});
		});
	});
	it("adopts existing prices and a deliberately disabled dedicated endpoint", async () => {
		await withSetup(false, async (service, stripe, deliver) => {
			const client = stripe.client(stripe.credentials().setupKey);
			const product = await client.products.create({ name: "Existing" });
			const price = await client.prices.create({
				product: product.id,
				currency: "usd",
				unit_amount: 1000,
				tax_behavior: "unspecified",
			});
			const endpoint = await client.webhookEndpoints.create({
				url: "https://billing.example.com/pending",
				enabled_events: ["product.updated"],
				api_version: STRIPE_API_VERSION,
			});
			await client.webhookEndpoints.update(endpoint.id, { disabled: true });
			const manifest = {
				...setupManifest(),
				bindings: [
					{
						source: "reuse",
						productKey: "credits_10",
						name: "Existing",
						kind: "topup",
						entitlementKey: "ai_credits",
						credits: 10,
						externalProductId: product.id,
						externalPriceId: price.id,
					},
				],
				webhook: { source: "reuse", endpointId: endpoint.id },
			};
			const credentials = { ...stripe.credentials(), webhookSecret: "whsec_setup" };
			const run = await service.prepare(manifest, credentials);
			expect((await service.apply(run.setupId, credentials)).status).toBe("awaiting_setup_event");
			await deliver();
			expect((await service.apply(run.setupId, credentials)).status).toBe(
				"awaiting_delivery_event",
			);
			await deliver();
			expect((await service.apply(run.setupId, credentials)).status).toBe("complete");
			expect(stripe.count("price")).toBe(1);
			expect(stripe.count("webhook_endpoint")).toBe(1);
		});
	});
	for (const production of [false, true])
		it(`configures ${production ? "production" : "sandbox"} only after both signed deliveries, resumes and re-verifies`, async () => {
			await withSetup(production, async (service, stripe, deliver) => {
				const manifest = setupManifest(production);
				const credentials = stripe.credentials();
				const prepared = await service.prepare(manifest, credentials);
				expect(prepared.status).toBe("prepared");
				expect(stripe.calls.every((call) => call.method === "GET")).toBe(true);
				const first = await service.apply(prepared.setupId, credentials);
				expect(first.status).toBe("awaiting_setup_event");
				expect(
					await service.options.context.repository.active(
						(await service.store.get(prepared.setupId)).project_instance_id,
						"stripe",
					),
				).toBeNull();
				await deliver();
				expect((await service.apply(prepared.setupId, credentials)).status).toBe(
					"awaiting_delivery_event",
				);
				await deliver();
				const complete = await service.apply(prepared.setupId, credentials);
				expect(complete).toMatchObject({
					status: "complete",
					configurationVerified: true,
					catalogRevision: 1,
					paymentTest: "not_performed",
				});
				expect(stripe.count("product")).toBe(2);
				expect(stripe.count("price")).toBe(1);
				expect(stripe.count("webhook_endpoint")).toBe(1);
				expect((await service.store.get(prepared.setupId)).secret).toBeNull();
				expect((await service.prepare(manifest, credentials)).setupId).toBe(prepared.setupId);
				expect((await service.apply(prepared.setupId, credentials)).status).toBe("complete");
				expect((await service.apply(prepared.setupId, credentials, true)).status).toBe(
					"awaiting_delivery_event",
				);
				await deliver();
				expect((await service.apply(prepared.setupId, credentials)).status).toBe("complete");
				expect(stripe.count("price")).toBe(1);
			});
		});
	it("recovers an unknown create using the same request, fences competing runners and rejects plan drift", async () => {
		await withSetup(false, async (service, stripe) => {
			const prepared = await service.prepare(setupManifest(), stripe.credentials());
			await expect(
				service.prepare(
					{ ...setupManifest(), publicOrigin: "https://other.example" },
					stripe.credentials(),
				),
			).rejects.toThrow("setup_manifest_conflict");
			const token = crypto.randomUUID();
			expect(await service.store.claim(prepared.setupId, token)).toBe(true);
			await expect(service.apply(prepared.setupId, stripe.credentials())).rejects.toThrow(
				"setup_busy",
			);
			await service.store.release(prepared.setupId, token);
			stripe.failAfterCreate = "products";
			expect((await service.apply(prepared.setupId, stripe.credentials())).status).toBe(
				"awaiting_setup_event",
			);
			expect((await service.apply(prepared.setupId, stripe.credentials())).status).toBe(
				"awaiting_setup_event",
			);
			expect(stripe.count("product")).toBe(2);
			const receipts = await f.sql`SELECT request,result FROM platform_stripe_setup_steps`;
			expect(JSON.stringify(receipts)).not.toContain("rk_");
			expect(JSON.stringify(receipts)).not.toContain("whsec_");
			const run = await service.store.get(prepared.setupId);
			expect(service.store.open(run)).toBe("whsec_setup");
			expect(JSON.stringify(run)).not.toContain("whsec_setup");
		});
	});
	it("rejects wrong credentials before changes and keeps invalid signatures unverified", async () => {
		await withSetup(true, async (service, stripe, deliver) => {
			await expect(
				service.prepare(setupManifest(true), {
					...stripe.credentials(),
					runtimeKey: "rk_test_wrong",
				}),
			).rejects.toThrow("credential_mode_mismatch");
			expect(stripe.calls).toHaveLength(0);
			const prepared = await service.prepare(setupManifest(true), stripe.credentials());
			expect((await service.apply(prepared.setupId, stripe.credentials())).status).toBe(
				"awaiting_setup_event",
			);
			await deliver(true);
			expect((await service.apply(prepared.setupId, stripe.credentials())).status).toBe(
				"awaiting_setup_event",
			);
			expect((await service.status(prepared.setupId)).configurationVerified).toBe(false);
		});
	});
});
