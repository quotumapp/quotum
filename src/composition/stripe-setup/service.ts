import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { BillingError } from "../../billing/errors";
import { CatalogBindings } from "../../catalog/bindings";
import { BillingRepository } from "../../db/repository";
import type { ConnectionCipher } from "../../platform/connections/cipher";
import type { ConnectionGate } from "../../platform/connections/lifecycle";
import {
	type StripeSetupRun,
	StripeSetupStore,
} from "../../platform/connections/stripe-setup-store";
import { MerchantError } from "../../platform/security";
import { STRIPE_API_VERSION } from "../../providers/stripe/client";
import { canonicalJson } from "../../shared/canonical-json";
import type { OperatorContext, OperatorTarget } from "../cli/operator-context";
import { createConnectionValidation } from "../connection-validation";
import { stripeWritePermissions, validateStripeAccess } from "../stripe-connection-validation";
import {
	checkEndpoint,
	checkSetupAccounts,
	inspectBinding,
	SetupProviderWrites,
	setupStripeClient,
} from "./provider";
import {
	type SetupCredentials,
	SetupFailure,
	type StripeSetupManifest,
	setupDiagnostics,
	stripeSetupEvents,
	stripeSetupManifestSchema,
} from "./schema";

interface SetupState {
	[key: string]: unknown;
	status?: string;
	draftId?: string;
	generation?: number;
	endpointId?: string;
	probeProductId?: string;
	deliveryNonce?: string;
	deliveryEventId?: string | null;
	deliveryVerifiedAt?: string | null;
	verification?: number;
	setupVerified?: boolean;
	committed?: boolean;
	publishedRevision?: number;
	completedAt?: string;
}
export interface StripeSetupOptions {
	context: OperatorContext;
	cipher: ConnectionCipher;
	actor: string;
	memberOverrideReason?: string;
	client?: (key: string) => Stripe;
}

export class StripeSetupService {
	readonly store: StripeSetupStore;
	readonly client: (key: string) => Stripe;
	constructor(readonly options: StripeSetupOptions) {
		this.store = new StripeSetupStore(options.context.sql, options.cipher);
		this.client = options.client ?? setupStripeClient;
	}
	private async target(manifest: StripeSetupManifest, write: boolean) {
		const context = this.options.context;
		const target = await context.target(manifest.instance);
		if (target.environment !== manifest.environment)
			throw new SetupFailure("instance_environment_mismatch");
		const gate = context.gate(target, this.options.actor, {
			memberOverrideReason: this.options.memberOverrideReason,
		});
		await gate.instance(context.sql, write);
		return { target, gate };
	}
	private async noOtherConnection(target: OperatorTarget, draftId?: string) {
		const current = (await this.options.context.repository.list(target.instanceId)).find(
			(row) => row.kind === "stripe",
		);
		if (current?.active_version_id && current.active_version_id !== draftId)
			throw new SetupFailure("existing_connection_replacement_not_supported");
	}
	async prepare(input: unknown, credentials: SetupCredentials) {
		const manifest = stripeSetupManifestSchema.parse(input);
		const { target, gate } = await this.target(manifest, true);
		const fingerprint = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
		const prepared = await this.store.forInstance(target.instanceId);
		if (prepared) {
			if (prepared.fingerprint !== fingerprint) throw new SetupFailure("setup_manifest_conflict");
			return this.report(prepared);
		}
		await checkSetupAccounts(manifest, credentials, this.client);
		await this.noOtherConnection(target);
		if (
			await this.store.accountClaimed(
				manifest.accountId,
				manifest.environment === "production",
				target.instanceId,
			)
		)
			throw new SetupFailure("stripe_account_already_assigned");
		const catalog = await new BillingRepository(
			this.options.context.billingDatabase,
		).getPublishedCatalog(target.project);
		if (catalog.revision !== manifest.expectedRevision)
			throw new SetupFailure("catalog_revision_changed");
		const provider = this.client(credentials.setupKey);
		await validateStripeAccess(this.client(credentials.runtimeKey), {
			writeProbes: false,
			eventRead: true,
		});
		// Run the normal input validator before saving any plan, including HTTPS return settings.
		createConnectionValidation().normalize("stripe", target.environment, {
			settings: manifest.settings,
			secrets: {
				secretKey: credentials.runtimeKey,
				webhookSecret: credentials.webhookSecret ?? "whsec_pending",
			},
		});
		for (const binding of manifest.bindings)
			if (binding.source === "reuse")
				await inspectBinding(provider, binding, target.environment === "production");
		if (manifest.webhook.source === "reuse") {
			const endpoint = await provider.webhookEndpoints.retrieve(manifest.webhook.endpointId);
			checkEndpoint(endpoint, target.environment === "production");
			if (endpoint.status !== "disabled" || !credentials.webhookSecret)
				throw new SetupFailure("reuse_requires_disabled_endpoint_and_signing_secret");
		}
		const run = await this.options.context.sql.begin(async (tx) => {
			await gate.instance(tx, true);
			await gate.lock(tx);
			const existing = await new StripeSetupStore(tx, this.options.cipher).prepare(
				randomUUID(),
				target.instanceId,
				manifest.instance,
				this.options.actor,
				fingerprint,
				manifest,
			);
			await this.noOtherConnection(target, (existing.state as SetupState).draftId);
			return existing;
		});
		return this.report(run);
	}
	async status(id: string) {
		const run = await this.store.get(id);
		await this.target(stripeSetupManifestSchema.parse(run.manifest), false);
		return this.report(run);
	}
	private report(run: StripeSetupRun) {
		const state = run.state as SetupState;
		return {
			setupId: run.id,
			instance: run.instance_key,
			actor: run.actor,
			manifest: run.manifest,
			status: state.status ?? "prepared",
			reason: state.reason ?? null,
			currentStep: state.currentStep ?? null,
			checks: state.checks ?? null,
			endpointId: state.endpointId ?? null,
			draftId: state.draftId ?? null,
			configurationVerified: state.status === "complete",
			deliveryVerifiedAt: state.deliveryVerifiedAt ?? null,
			catalogRevision: state.publishedRevision ?? null,
			paymentTest: "not_performed",
			nextAction:
				state.status === "complete"
					? "Use the normal Checkout API; payment testing is separate."
					: "Resolve the reported blocker, then apply this setup ID with the same credentials. A pending webhook can be resumed immediately.",
			probe:
				"Creates an inactive Stripe product without a price for nonfinancial signed delivery verification.",
		};
	}
	async apply(id: string, credentials: SetupCredentials, verify = false) {
		let run = await this.store.get(id);
		const manifest = stripeSetupManifestSchema.parse(run.manifest);
		const { target, gate } = await this.target(manifest, true);
		if (verify && !run.state.committed) throw new SetupFailure("setup_not_committed_use_apply");
		const lease = randomUUID();
		if (!(await this.store.claim(id, lease))) throw new SetupFailure("setup_busy");
		let leaseLost = false;
		const heartbeat = setInterval(() => {
			void this.store.renew(id, lease).catch(() => {
				leaseLost = true;
			});
		}, 20_000);
		const authorize = async () => {
			if (leaseLost) throw new SetupFailure("setup_lease_lost");
			await gate.instance(this.options.context.sql, true);
			await this.noOtherConnection(
				target,
				(await this.store.get(id)).state.draftId as string | undefined,
			);
		};
		try {
			await authorize();
			await this.store.patch(id, lease, {
				lastActor: this.options.actor,
				memberOverrideReason: this.options.memberOverrideReason ?? null,
				checks: null,
			});
			await checkSetupAccounts(manifest, credentials, this.client);
			if (verify && run.state.committed) {
				await this.store.patch(id, lease, {
					verification: Number(run.state.verification ?? 0) + 1,
					deliveryNonce: null,
					deliveryEventId: null,
					deliveryVerifiedAt: null,
					status: "verifying",
				});
			}
			await this.execute(run, manifest, credentials, target, gate, lease, authorize);
		} catch (error) {
			// Never copy a provider's free-form message, request or response into a receipt.
			const reason =
				error instanceof SetupFailure
					? error.reason
					: error instanceof MerchantError || error instanceof BillingError
						? error.code
						: "setup_operation_failed_check_permissions_and_provider_availability";
			await this.store
				.patch(id, lease, { status: "requires_review", reason, checks: setupDiagnostics(error) })
				.catch(() => undefined);
		} finally {
			clearInterval(heartbeat);
			await this.store.release(id, lease);
		}
		run = await this.store.get(id);
		return this.report(run);
	}
	private async execute(
		run: StripeSetupRun,
		manifest: StripeSetupManifest,
		credentials: SetupCredentials,
		target: OperatorTarget,
		gate: ConnectionGate,
		lease: string,
		authorize: () => Promise<void>,
	) {
		const { context } = this.options;
		const provider = this.client(credentials.setupKey);
		const runtime = this.client(credentials.runtimeKey);
		const writes = new SetupProviderWrites(this.store, run, lease, authorize);
		let state = (await this.store.get(run.id)).state as SetupState;
		const patch = async (value: SetupState) => {
			await this.store.patch(run.id, lease, value);
			state = { ...state, ...value };
		};
		const repository = new BillingRepository(context.billingDatabase);
		const currentCatalog = await repository.getPublishedCatalog(target.project);
		if (
			state.publishedRevision === undefined &&
			currentCatalog.revision !== manifest.expectedRevision
		) {
			// Publication may have committed before its local receipt was recorded.
			if (
				currentCatalog.intentHash !== state.publicationIntentHash ||
				currentCatalog.revision !== (manifest.expectedRevision ?? 0) + 1
			)
				throw new SetupFailure("catalog_revision_changed");
			if (currentCatalog.revision !== null)
				await patch({ publishedRevision: currentCatalog.revision });
		}
		const access = await validateStripeAccess(runtime, { eventRead: true });
		if (
			access.unverifiedPermissions?.some((permission) =>
				stripeWritePermissions.some((required) => required === permission),
			)
		)
			throw new SetupFailure("runtime_write_permissions_unverified_retry_validation");
		const ids: Array<{ product: string; price: string }> = [];
		for (const binding of manifest.bindings) {
			if (binding.source === "reuse")
				ids.push(await inspectBinding(runtime, binding, target.environment === "production"));
			else {
				const productKey = `product:${binding.productKey}`;
				const productParams = { name: binding.name, metadata: writes.metadata(productKey) };
				const product = await writes.write(
					productKey,
					productParams,
					(options) => provider.products.create(productParams, options),
					() => writes.find(provider.products.list({ limit: 100 }), productKey),
				);
				const priceKey = `price:${binding.productKey}`;
				const priceParams: Stripe.PriceCreateParams = {
					product: product.id,
					currency: binding.currency,
					unit_amount: binding.unitAmountMinor,
					tax_behavior: binding.taxBehavior,
					metadata: writes.metadata(priceKey),
					...(binding.interval
						? {
								recurring: {
									interval: binding.interval,
									interval_count: binding.intervalCount,
									usage_type: "licensed",
								},
							}
						: {}),
				};
				const price = await writes.write(
					priceKey,
					priceParams,
					(options) => provider.prices.create(priceParams, options),
					() => writes.find(provider.prices.list({ product: product.id, limit: 100 }), priceKey),
				);
				ids.push(
					await inspectBinding(runtime, binding, target.environment === "production", {
						product: product.id,
						price: price.id,
					}),
				);
			}
		}
		const regularUrl = `${manifest.publicOrigin}/v1/projects/${manifest.instance}/webhooks/stripe`;
		if (!state.endpointId) {
			if (manifest.webhook.source === "reuse") {
				const endpoint = await provider.webhookEndpoints.retrieve(manifest.webhook.endpointId);
				checkEndpoint(endpoint, target.environment === "production");
				if (endpoint.status !== "disabled" || !credentials.webhookSecret)
					throw new SetupFailure("reuse_requires_disabled_endpoint_and_signing_secret");
				await this.store.seal(run, lease, credentials.webhookSecret);
				await patch({ endpointId: endpoint.id });
			} else {
				const params: Stripe.WebhookEndpointCreateParams = {
					url: regularUrl,
					enabled_events: ["product.updated"],
					api_version: STRIPE_API_VERSION,
					metadata: writes.metadata("endpoint"),
				};
				const endpoint = await writes.write(
					"endpoint",
					params,
					(options) => provider.webhookEndpoints.create(params, options),
					() => writes.find(provider.webhookEndpoints.list({ limit: 100 }), "endpoint"),
				);
				await patch({ endpointId: endpoint.id });
			}
		}
		const endpointId = String(state.endpointId);
		checkEndpoint(
			await provider.webhookEndpoints.retrieve(endpointId),
			target.environment === "production",
		);
		if (!state.probeProductId) {
			const params = {
				name: "Quotum connection verification (not for sale)",
				active: false,
				metadata: writes.metadata("probe-product"),
			};
			const probe = await writes.write(
				"probe-product",
				params,
				(options) => provider.products.create(params, options),
				() => writes.find(provider.products.list({ limit: 100 }), "probe-product"),
			);
			await patch({ probeProductId: probe.id });
		}
		const probeProductId = String(state.probeProductId);
		let draft = state.draftId
			? await context.repository.version(target.instanceId, state.draftId).catch(() => null)
			: null;
		if (
			!state.committed &&
			(!draft || (draft.status !== "active" && draft.expires_at.getTime() <= Date.now()))
		) {
			const latest = await this.store.get(run.id);
			let secret = this.store.open(latest);
			if (!secret && credentials.webhookSecret) {
				secret = credentials.webhookSecret;
				await this.store.seal(run, lease, secret);
			}
			if (!secret) throw new SetupFailure("webhook_secret_unavailable_supply_from_dashboard");
			const generation = Number(state.generation ?? 0) + 1;
			await authorize();
			await this.store.renew(run.id, lease);
			const receipt = await context.lifecycle.draft(
				gate,
				"stripe",
				`${run.id}:draft:${generation}`,
				{
					settings: manifest.settings,
					secrets: { secretKey: credentials.runtimeKey, webhookSecret: secret },
					expectedRevision: 0,
				},
			);
			await patch({ draftId: receipt.draftId, generation, setupVerified: false });
			draft = await context.repository.version(target.instanceId, receipt.draftId);
		}
		if (!draft) throw new SetupFailure("connection_draft_unavailable");
		const storedSecrets = await context.repository.secrets(draft);
		if (storedSecrets.secretKey !== credentials.runtimeKey)
			throw new SetupFailure("runtime_key_changed_use_original_credentials");
		if (!state.committed && draft.status === "active")
			await patch({ committed: true, setupVerified: true });
		const generation = Number(state.generation ?? 1);
		const updateEndpoint = async (
			key: string,
			url: string,
			events: Stripe.WebhookEndpointUpdateParams["enabled_events"],
		) => {
			const params = { url, enabled_events: events, disabled: false };
			await writes.write(
				key,
				{ id: endpointId, ...params },
				(options) => provider.webhookEndpoints.update(endpointId, params, options),
				async () => {
					const actual = await provider.webhookEndpoints.retrieve(endpointId);
					return actual.url === url &&
						actual.status === "enabled" &&
						canonicalJson([...actual.enabled_events].sort()) ===
							canonicalJson([...(events ?? [])].sort())
						? actual
						: null;
				},
			);
		};
		if (!state.committed) {
			await context.lifecycle.validate(gate, "stripe", draft.id);
			await updateEndpoint(
				`setup-endpoint:${generation}`,
				`${manifest.publicOrigin}/v1/projects/${manifest.instance}/connections/${draft.id}/webhooks/stripe`,
				["product.updated"],
			);
			if (!draft.event_verified_at) {
				// Stripe timestamps have second precision; the draft has microsecond precision.
				// Generate the event in a later second so the existing freshness gate can accept it.
				await Bun.sleep(Math.max(0, Math.ceil(Date.now() / 1000) * 1000 + 50 - Date.now()));
				// A new time bucket creates a fresh real event after the previous one became stale.
				const key = `setup-probe:${generation}:${Math.floor(Date.now() / 240_000)}`;
				const params = { metadata: { quotum_setup_id: run.id, quotum_setup_probe: key } };
				await writes.write(key, params, (options) =>
					provider.products.update(probeProductId, params, options),
				);
				draft = await context.repository.version(target.instanceId, draft.id);
				if (!draft.event_verified_at) {
					await patch({ status: "awaiting_setup_event", reason: null });
					return;
				}
			}
			await authorize();
			await this.store.renew(run.id, lease);
			await context.lifecycle.commit(gate, "stripe", draft.id, `${run.id}:commit:${generation}`);
			await patch({ committed: true, setupVerified: true });
		}
		const verification = Number(state.verification ?? 0);
		if (!state.deliveryVerifiedAt) {
			await updateEndpoint(`regular-endpoint:${generation}:${verification}`, regularUrl, [
				...stripeSetupEvents,
				"product.updated",
			]);
			if (
				!state.deliveryNonce ||
				Date.now() - new Date(String(state.deliveryStartedAt)).getTime() > 240_000
			) {
				await patch({
					deliveryNonce: randomUUID(),
					deliveryStartedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
					deliveryEventId: null,
					deliveryVerifiedAt: null,
				});
			}
			const params = {
				metadata: { quotum_setup_id: run.id, quotum_setup_probe: String(state.deliveryNonce) },
			};
			await writes.write(`delivery:${state.deliveryNonce}`, params, (options) =>
				provider.products.update(probeProductId, params, options),
			);
			const observed = (await this.store.get(run.id)).state as SetupState;
			if (!observed.deliveryVerifiedAt) {
				await patch({ status: "awaiting_delivery_event", reason: null });
				return;
			}
			state = observed;
		}
		const bindings = new CatalogBindings(context.billingDatabase, context.connections, this.client);
		for (const [index, binding] of manifest.bindings.entries()) {
			await authorize();
			await this.store.renew(run.id, lease);
			await bindings.adopt(
				target.project,
				{
					provider: "stripe",
					productKey: binding.productKey,
					name: binding.name,
					kind: binding.kind,
					entitlementKey: binding.entitlementKey,
					credits: binding.credits,
					externalProductId: ids[index]?.product ?? "",
					externalPriceId: ids[index]?.price ?? "",
				},
				`operator:${this.options.actor}`,
				`${run.id}:adopt:${index}`,
			);
		}
		const current = await repository.getPublishedCatalog(target.project);
		// Once a setup has completed, a later publication is ordinary catalog use; only the first run
		// guards the revision it published.
		if (
			state.completedAt === undefined &&
			state.publishedRevision !== undefined &&
			current.revision !== state.publishedRevision
		)
			throw new SetupFailure("catalog_changed_after_setup");
		if (state.publishedRevision === undefined) {
			await authorize();
			await this.store.renew(run.id, lease);
			const preview = await repository.previewCatalog(target.project, {
				catalog: manifest.catalog,
				expectedRevision: manifest.expectedRevision,
				actor: `operator:${this.options.actor}`,
			});
			await patch({ publicationIntentHash: preview.intentHash });
			const published = await repository.publishCatalog(target.project, {
				catalog: manifest.catalog,
				expectedRevision: manifest.expectedRevision,
				previewToken: preview.previewToken,
				actor: `operator:${this.options.actor}`,
			});
			await patch({ publishedRevision: published.revision });
		}
		await updateEndpoint(`final-endpoint:${generation}:${verification}`, regularUrl, [
			...stripeSetupEvents,
		]);
		const final = await provider.webhookEndpoints.retrieve(endpointId);
		const active = await context.repository.active(target.instanceId, "stripe");
		if (
			!active ||
			active.version.id !== draft.id ||
			active.version.external_identity !== manifest.accountId
		)
			throw new SetupFailure("active_connection_changed");
		if (
			final.url !== regularUrl ||
			final.status !== "enabled" ||
			canonicalJson([...final.enabled_events].sort()) !==
				canonicalJson([...stripeSetupEvents].sort())
		)
			throw new SetupFailure("webhook_configuration_changed");
		await this.store.seal(run, lease, null);
		await patch({
			status: "complete",
			completedAt: state.completedAt ?? new Date().toISOString(),
			reason: null,
			currentStep: null,
			checks: null,
		});
	}
}
