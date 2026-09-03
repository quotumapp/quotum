import { sql as drizzleSql } from "drizzle-orm";
import {
	canonicalDecimal,
	decimalToUnits,
	positiveDecimal,
	sha256Hex,
	stableJson,
} from "../billing/decimal";
import { BillingError, InvalidRequestError, PersistenceConflictError } from "../billing/errors";
import { RepositoryModule } from "../db/repository/base";
import { resolveProjectId } from "../db/repository/identities";
import { executeOne, executeRows, jsonb } from "../db/repository/query";
import type { QueryExecutor } from "../db/repository/types";
import type { ProjectContext } from "../projects/context";
import type {
	CatalogControlIntent,
	CatalogControlPlaneLike,
	CatalogFeatureIntent,
	CatalogImpact,
	CatalogIntent,
	CatalogPlanIntent,
	CatalogPreview,
	CatalogPreviewInput,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
	CatalogPublishInput,
	CatalogPublishResult,
	PublishedCatalog,
} from "./types";

interface ProjectCatalogRow {
	id: string;
	revision: number | null;
	revision_id: string | number | bigint | null;
}

interface DraftRow {
	intent_hash: string;
	intent: CatalogIntent;
	base_revision: number | null;
	next_revision: number;
	status: "previewed" | "published" | "expired";
	expires_at: Date | string;
	published_revision_id: string | number | bigint | null;
}

export class CatalogControlPlane extends RepositoryModule implements CatalogControlPlaneLike {
	async getPublished(project: ProjectContext): Promise<PublishedCatalog> {
		const projectState = await readProjectCatalog(this.database, project, false);
		if (projectState.revision_id === null || projectState.revision === null) {
			return {
				revisionId: null,
				revision: null,
				intentHash: null,
				publishedAt: null,
				catalog: null,
			};
		}
		const row = await executeOne<{
			intent_hash: string;
			published_at: Date | string;
			intent: CatalogIntent;
		}>(
			this.database,
			drizzleSql`
				SELECT revision.intent_hash, revision.published_at, draft.intent
				FROM catalog_revisions revision
				JOIN catalog_drafts draft
					ON draft.project_id = revision.project_id
					AND draft.published_revision_id = revision.id
					AND draft.status = 'published'
				WHERE revision.project_id = ${projectState.id}
					AND revision.id = ${String(projectState.revision_id)}::bigint
			`,
		);
		if (row === null) throw new Error("Published catalog intent was not found");
		return {
			revisionId: String(projectState.revision_id),
			revision: projectState.revision,
			intentHash: row.intent_hash,
			publishedAt: toIso(row.published_at),
			catalog: normalizeCatalog(row.intent),
		};
	}

	async preview(project: ProjectContext, input: CatalogPreviewInput): Promise<CatalogPreview> {
		const catalog = normalizeCatalog(input.catalog);
		return await this.transaction(async (tx) => {
			const projectState = await readProjectCatalog(tx, project, false);
			assertExpectedRevision(input.expectedRevision, projectState.revision);
			await validateCatalogLifecycle(tx, projectState.id, catalog);
			const intentHash = sha256Hex(stableJson(catalog));
			const nextRevision = (projectState.revision ?? 0) + 1;
			const previewToken = sha256Hex(
				stableJson({
					projectId: projectState.id,
					baseRevision: projectState.revision,
					nextRevision,
					intentHash,
					nonce: crypto.randomUUID(),
				}),
			);
			const expiresAt = new Date(Date.now() + 30 * 60_000);
			const impact = await calculateImpact(tx, projectState.id, catalog);
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO catalog_drafts (
						project_id,
						base_revision,
						next_revision,
						intent_hash,
						preview_token,
						intent,
						created_by,
						expires_at
					)
					VALUES (
						${projectState.id},
						${projectState.revision},
						${nextRevision},
						${intentHash},
						${previewToken},
						${jsonb(catalog)},
						${requireActor(input.actor)},
						${expiresAt.toISOString()}
					)
					RETURNING id
				`,
			);
			return {
				previewToken,
				intentHash,
				baseRevision: projectState.revision,
				nextRevision,
				expiresAt: expiresAt.toISOString(),
				impact,
			};
		});
	}

	async publish(
		project: ProjectContext,
		input: CatalogPublishInput,
	): Promise<CatalogPublishResult> {
		const catalog = normalizeCatalog(input.catalog);
		return await this.transaction(async (tx) => {
			const projectState = await readProjectCatalog(tx, project, true);
			const token = input.previewToken.trim();
			if (!/^[a-f0-9]{64}$/.test(token)) {
				throw new InvalidRequestError("previewToken must be a SHA-256 token");
			}
			const draft = await executeOne<DraftRow>(
				tx,
				drizzleSql`
					SELECT
						intent_hash,
						intent,
						base_revision,
						next_revision,
						status,
						expires_at,
						published_revision_id
					FROM catalog_drafts
					WHERE project_id = ${projectState.id}
						AND preview_token = ${token}
					FOR UPDATE
				`,
			);
			if (draft === null) {
				throw new PersistenceConflictError(
					"Catalog preview was not found",
					"CATALOG_PREVIEW_NOT_FOUND",
				);
			}
			if (draft.status === "published" && draft.published_revision_id !== null) {
				return await readPublishedResult(
					tx,
					projectState.id,
					String(draft.published_revision_id),
					true,
				);
			}
			if (draft.status !== "previewed" || new Date(draft.expires_at).getTime() <= Date.now()) {
				throw new PersistenceConflictError(
					"Catalog preview has expired",
					"CATALOG_PREVIEW_EXPIRED",
				);
			}
			assertExpectedRevision(input.expectedRevision, projectState.revision);
			if (draft.base_revision !== projectState.revision) {
				throw new PersistenceConflictError(
					"Published catalog changed after preview",
					"CATALOG_PREVIEW_STALE",
				);
			}
			const intentHash = sha256Hex(stableJson(catalog));
			if (draft.intent_hash !== intentHash || stableJson(draft.intent) !== stableJson(catalog)) {
				throw new PersistenceConflictError(
					"Catalog publish intent differs from its preview",
					"CATALOG_PREVIEW_MISMATCH",
				);
			}

			await validateCatalogLifecycle(tx, projectState.id, catalog);
			const impact = await calculateImpact(tx, projectState.id, catalog);
			const currentCatalog = await readCurrentCatalogIntent(tx, projectState.id);
			const changedCatalog = {
				...catalog,
				plans: changedPlans(currentCatalog, catalog),
			};
			const revision = await executeOne<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
					INSERT INTO catalog_revisions (
						project_id,
						revision,
						status,
						intent_hash,
						created_by,
						published_at,
						metadata
					)
					VALUES (
						${projectState.id},
						${draft.next_revision},
						'validating',
						${intentHash},
						${requireActor(input.actor)},
						NULL,
						${jsonb({ impact })}
					)
					RETURNING id
				`,
			);
			if (revision === null) throw new Error("Catalog revision could not be persisted");
			const featureIds = await publishFeatures(tx, projectState.id, catalog.features);
			const publishedPlans = await publishPlans(
				tx,
				projectState.id,
				String(revision.id),
				changedCatalog,
				featureIds,
			);
			await publishRateCards(tx, projectState.id, String(revision.id), catalog, featureIds);
			await publishProviderBindings(
				tx,
				projectState.id,
				String(revision.id),
				changedCatalog,
				publishedPlans.versionIds,
			);
			await publishProviderPriceBindings(
				tx,
				projectState.id,
				String(revision.id),
				changedCatalog,
				publishedPlans.priceComponentIds,
			);
			const topupOptionIds = await publishTopupOptions(
				tx,
				projectState.id,
				String(revision.id),
				catalog,
				featureIds,
			);
			await publishTopupProviderBindings(
				tx,
				projectState.id,
				String(revision.id),
				catalog,
				topupOptionIds,
			);
			await applyCatalogRetirements(tx, projectState.id, catalog);
			const activatedRevision = await executeOne<{ published_at: Date | string }>(
				tx,
				drizzleSql`
					UPDATE catalog_revisions
					SET status = 'published', published_at = now(), updated_at = now()
					WHERE project_id = ${projectState.id}
						AND id = ${String(revision.id)}::bigint
						AND status = 'validating'
						AND NOT EXISTS (
							SELECT 1
							FROM catalog_provider_operations operations
							WHERE operations.project_id = ${projectState.id}
								AND operations.catalog_revision_id = ${String(revision.id)}::bigint
								AND operations.status <> 'ready'
						)
					RETURNING published_at
				`,
			);
			if (activatedRevision === null) {
				throw new BillingError(
					"Catalog provider operations are not ready",
					"PROVIDER_BINDING_NOT_READY",
					409,
					{ classification: "persistence_conflict" },
				);
			}
			await executeOne(
				tx,
				drizzleSql`
					UPDATE projects
					SET published_catalog_revision_id = ${String(revision.id)}::bigint, updated_at = now()
					WHERE id = ${projectState.id}
					RETURNING id
				`,
			);
			await executeOne(
				tx,
				drizzleSql`
					UPDATE catalog_drafts
					SET
						status = 'published',
						published_revision_id = ${String(revision.id)}::bigint,
						updated_at = now()
					WHERE project_id = ${projectState.id}
						AND preview_token = ${token}
					RETURNING id
				`,
			);
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO catalog_audit_log (
						project_id,
						catalog_revision_id,
						action,
						actor,
						intent_hash,
						details
					)
					VALUES (
						${projectState.id},
						${String(revision.id)}::bigint,
						'catalog_published',
						${requireActor(input.actor)},
						${intentHash},
						${jsonb({ impact, previewToken: token })}
					)
					RETURNING id
				`,
			);
			return {
				revisionId: String(revision.id),
				revision: draft.next_revision,
				intentHash,
				publishedAt: toIso(activatedRevision.published_at),
				duplicate: false,
				impact,
			};
		});
	}
}

async function readProjectCatalog(
	executor: QueryExecutor,
	project: ProjectContext,
	lock: boolean,
): Promise<ProjectCatalogRow> {
	const projectId = await resolveProjectId(executor, project);
	const row = await executeOne<ProjectCatalogRow>(
		executor,
		drizzleSql`
			SELECT p.id, cr.id AS revision_id, cr.revision
			FROM projects p
			LEFT JOIN catalog_revisions cr
				ON cr.project_id = p.id
				AND cr.id = p.published_catalog_revision_id
			WHERE p.id = ${projectId}
			${lock ? drizzleSql`FOR UPDATE OF p` : drizzleSql``}
		`,
	);
	if (row === null) throw new Error(`Billing project ${project.projectKey} was not found`);
	return row;
}

function assertExpectedRevision(expected: number | null, actual: number | null): void {
	if (expected !== actual) {
		throw new PersistenceConflictError(
			`Expected catalog revision ${String(expected)}, current revision is ${String(actual)}`,
			"CATALOG_REVISION_CONFLICT",
		);
	}
}

function normalizeCatalog(catalog: CatalogIntent): CatalogIntent {
	const retiredFeatureKeys = normalizedRetirementKeys(
		catalog.retiredFeatureKeys,
		"retired feature key",
	);
	const retiredPlanKeys = normalizedRetirementKeys(catalog.retiredPlanKeys, "retired plan key");
	const retiredTopupKeys = normalizedRetirementKeys(catalog.retiredTopupKeys, "retired top-up key");
	const features = catalog.features.map((feature) => ({
		...feature,
		key: normalizedKey(feature.key, "feature key"),
		name: requiredText(feature.name, "feature name", 200),
		unit: normalizedKey(feature.unit, "feature unit"),
		filterDimensions: [
			...new Set(feature.filterDimensions.map((key) => normalizedKey(key, "filter dimension"))),
		].sort(),
	}));
	assertUnique(
		features.map(({ key }) => key),
		"feature key",
	);
	assertNoActiveRetirementOverlap(
		features.map(({ key }) => key),
		retiredFeatureKeys,
		"feature",
	);
	if (features.length === 0 || features.length > 100) {
		throw new InvalidRequestError("A catalog must define between 1 and 100 features");
	}
	const featureByKey = new Map(features.map((feature) => [feature.key, feature]));
	for (const feature of features) validateFeature(feature);

	const plans = catalog.plans.map((plan) => {
		const legacyBindings = plan.providerBindings
			.map(normalizeProviderBinding)
			.sort((left, right) =>
				providerBindingIdentity(left).localeCompare(providerBindingIdentity(right)),
			);
		const explicitBasePrice =
			plan.basePrice === undefined
				? null
				: plan.basePrice === null
					? null
					: normalizePrice(plan.basePrice, "base price");
		const basePrice = explicitBasePrice;
		return {
			...plan,
			key: normalizedKey(plan.key, "plan key"),
			name: requiredText(plan.name, "plan name", 200),
			kind: plan.kind ?? "base",
			visibility: plan.visibility ?? "public",
			customerBillingAccountId:
				plan.customerBillingAccountId === undefined || plan.customerBillingAccountId === null
					? null
					: requiredText(plan.customerBillingAccountId, "customer billing account id", 200),
			tierRank: plan.tierRank ?? 0,
			trialRequiresPaymentMethod: plan.trialRequiresPaymentMethod ?? true,
			trialEndBehavior: plan.trialEndBehavior ?? "cancel",
			upgradeProrationBehavior: plan.upgradeProrationBehavior ?? "always_invoice",
			downgradeProrationBehavior: plan.downgradeProrationBehavior ?? "none",
			basePrice,
			currency: basePrice?.currency ?? plan.currency?.trim().toUpperCase() ?? null,
			baseAmountMinor: basePrice?.unitAmountMinor ?? plan.baseAmountMinor,
			billingInterval: basePrice?.billingInterval ?? plan.billingInterval,
			items: plan.items.map((item) => ({
				...item,
				featureKey: normalizedKey(item.featureKey, "plan item feature key"),
				quantity:
					item.quantity === null ? null : positiveDecimal(item.quantity, "plan item quantity"),
				price:
					item.price === undefined || item.price === null
						? null
						: normalizePrice(item.price, `price for ${item.featureKey}`),
				allocationScope: item.allocationScope ?? "account",
				rollover:
					item.rollover === undefined || item.rollover === null
						? null
						: {
								maxQuantity:
									item.rollover.maxQuantity === null
										? null
										: positiveDecimal(item.rollover.maxQuantity, "rollover maxQuantity"),
								expiry: item.rollover.expiry,
							},
			})),
			controls: (plan.controls ?? []).map((control) => normalizeControl(control, featureByKey)),
			providerBindings:
				legacyBindings.length > 0 ? legacyBindings : (basePrice?.providerBindings ?? []),
		};
	});
	assertUnique(
		plans.map(({ key }) => key),
		"plan key",
	);
	assertNoActiveRetirementOverlap(
		plans.map(({ key }) => key),
		retiredPlanKeys,
		"plan",
	);
	for (const plan of plans) {
		if (!Number.isInteger(plan.version) || plan.version < 1) {
			throw new InvalidRequestError(`Plan ${plan.key} version must be a positive integer`);
		}
		if ((plan.visibility === "customer_specific") !== (plan.customerBillingAccountId !== null)) {
			throw new InvalidRequestError(
				`Plan ${plan.key} customer-specific visibility requires one billing account`,
			);
		}
		assertUnique((plan.controls ?? []).map(controlIdentity), `plan ${plan.key} control`);
		assertUnique(
			plan.items.map(({ featureKey }) => featureKey),
			`plan ${plan.key} item feature`,
		);
		for (const item of plan.items) {
			const feature = featureByKey.get(item.featureKey);
			if (feature === undefined) {
				throw new InvalidRequestError(
					`Plan ${plan.key} references unknown feature ${item.featureKey}`,
				);
			}
			if (item.itemKind === "access" && item.quantity !== null) {
				throw new InvalidRequestError(`Access item ${item.featureKey} cannot have a quantity`);
			}
			if (item.itemKind !== "access" && item.quantity === null) {
				throw new InvalidRequestError(`Metered item ${item.featureKey} requires a quantity`);
			}
			if (
				item.itemKind === "meter_limit" &&
				(feature.kind !== "metered" || item.resetInterval === null)
			) {
				throw new InvalidRequestError(
					`Meter limit ${item.featureKey} requires a metered feature and reset interval`,
				);
			}
			if (item.itemKind === "licensed_quantity" && feature.meterKind !== "non_consumable") {
				throw new InvalidRequestError(
					`Licensed quantity ${item.featureKey} requires a non-consumable metered feature`,
				);
			}
			if (item.itemKind === "licensed_quantity" && item.price === null) {
				throw new InvalidRequestError(`Licensed quantity ${item.featureKey} requires a price`);
			}
			if (item.overagePolicy === "allowed" && item.itemKind !== "meter_limit") {
				throw new InvalidRequestError("Only meter limits can allow postpaid overage");
			}
			if (item.overagePolicy === "allowed" && item.price === null) {
				throw new InvalidRequestError(`Meter limit ${item.featureKey} requires an overage price`);
			}
			if (item.price !== null && item.itemKind === "access") {
				throw new InvalidRequestError(`Access item ${item.featureKey} cannot declare a price`);
			}
			if (
				item.price !== null &&
				plan.billingInterval !== null &&
				item.price.billingInterval !== plan.billingInterval
			) {
				throw new InvalidRequestError(`Plan ${plan.key} price intervals must match`);
			}
			if (item.price !== null && plan.currency !== null && item.price.currency !== plan.currency) {
				throw new InvalidRequestError(`Plan ${plan.key} price currencies must match`);
			}
			if (item.rollover !== null) {
				if (item.itemKind !== "allocation" || item.resetInterval === null) {
					throw new InvalidRequestError(
						`Rollover for ${item.featureKey} requires a resetting allocation`,
					);
				}
				if (
					item.rollover.expiry.mode === "months" &&
					(!Number.isInteger(item.rollover.expiry.months) ||
						item.rollover.expiry.months < 1 ||
						item.rollover.expiry.months > 120)
				) {
					throw new InvalidRequestError("Rollover expiry months must be between 1 and 120");
				}
			}
			if (item.allocationScope === "license_pool" && item.itemKind !== "licensed_quantity") {
				throw new InvalidRequestError(
					`License-pool scope for ${item.featureKey} requires licensed quantity pricing`,
				);
			}
		}
		assertUnique(
			plan.providerBindings.map(providerBindingIdentity),
			`plan ${plan.key} provider binding`,
		);
		assertUnique(
			allPlanPriceBindings(plan).map(providerBindingIdentity),
			`plan ${plan.key} price provider binding`,
		);
		if (
			((plan.trialDays ?? 0) > 0 || plan.kind === "addon") &&
			plan.providerBindings.some((binding) => binding.provider !== "stripe")
		) {
			throw new InvalidRequestError(
				`Plan ${plan.key} trials and add-ons are currently supported only on Stripe web`,
			);
		}
	}

	const topups = catalog.topups.map((topup) => {
		const featureKey = normalizedKey(topup.featureKey, "top-up feature key");
		const feature = featureByKey.get(featureKey);
		if (feature === undefined || feature.kind !== "metered" || feature.meterKind !== "consumable") {
			throw new InvalidRequestError(`Top-up ${topup.key} must grant a consumable metered feature`);
		}
		return {
			...topup,
			key: normalizedKey(topup.key, "top-up key"),
			featureKey,
			quantity: positiveDecimal(topup.quantity, "top-up quantity", feature.creditScale),
			providerBindings: topup.providerBindings
				.map(normalizeProviderBinding)
				.sort((left, right) =>
					providerBindingIdentity(left).localeCompare(providerBindingIdentity(right)),
				),
		};
	});
	assertUnique(
		topups.map(({ key }) => key),
		"top-up key",
	);
	assertNoActiveRetirementOverlap(
		topups.map(({ key }) => key),
		retiredTopupKeys,
		"top-up",
	);
	for (const topup of topups) {
		assertUnique(
			topup.providerBindings.map(providerBindingIdentity),
			`top-up ${topup.key} provider binding`,
		);
	}
	assertUnique(
		[
			...plans.flatMap((plan) => allPlanPriceBindings(plan).map(providerBindingIdentity)),
			...topups.flatMap((topup) => topup.providerBindings.map(providerBindingIdentity)),
		],
		"provider product binding",
	);

	const rateCards = catalog.rateCards.map((entry) => {
		const pricingModel = entry.pricingModel ?? "flat";
		const tiers = (entry.tiers ?? []).map((tier) => ({
			upToQuantity:
				tier.upToQuantity === null
					? null
					: positiveDecimal(tier.upToQuantity, "rate-card tier boundary", 9),
			ratePerUnit: positiveDecimal(tier.ratePerUnit, "rate-card tier rate", 18),
		}));
		validateTierBoundaries(
			pricingModel,
			tiers.map(({ upToQuantity }) => upToQuantity),
			"rate card",
		);
		return {
			meterFeatureKey: normalizedKey(entry.meterFeatureKey, "meter feature key"),
			walletFeatureKey: normalizedKey(entry.walletFeatureKey, "wallet feature key"),
			ratePerUnit: positiveDecimal(entry.ratePerUnit, "ratePerUnit", 18),
			pricingModel,
			tiers,
		};
	});
	assertUnique(
		rateCards.map(({ meterFeatureKey }) => meterFeatureKey),
		"rate-card meter",
	);
	for (const entry of rateCards) {
		const meter = featureByKey.get(entry.meterFeatureKey);
		const wallet = featureByKey.get(entry.walletFeatureKey);
		if (meter === undefined || wallet === undefined) {
			throw new InvalidRequestError(
				"Rate cards must reference features in the same catalog intent",
			);
		}
		if (
			meter.key === wallet.key ||
			wallet.kind !== "metered" ||
			wallet.meterKind !== "consumable"
		) {
			throw new InvalidRequestError(
				"Rate-card wallets must be distinct consumable metered features",
			);
		}
	}
	const meterLimitFeatures = new Set(
		plans.flatMap((plan) =>
			plan.items.filter((item) => item.itemKind === "meter_limit").map((item) => item.featureKey),
		),
	);
	const allocationFeatures = new Set([
		...plans.flatMap((plan) =>
			plan.items.filter((item) => item.itemKind === "allocation").map((item) => item.featureKey),
		),
		...topups.map((topup) => topup.featureKey),
		...rateCards.map((entry) => entry.walletFeatureKey),
	]);
	for (const featureKey of meterLimitFeatures) {
		if (allocationFeatures.has(featureKey)) {
			throw new InvalidRequestError(
				`Feature ${featureKey} cannot use both a usage window and an allocation stack`,
			);
		}
	}
	return {
		features,
		plans,
		topups,
		rateCards,
		retiredFeatureKeys,
		retiredPlanKeys,
		retiredTopupKeys,
	};
}

function normalizedRetirementKeys(keys: string[] | undefined, field: string): string[] {
	return [...new Set((keys ?? []).map((key) => normalizedKey(key, field)))].sort();
}

function assertNoActiveRetirementOverlap(
	activeKeys: string[],
	retiredKeys: string[],
	label: string,
): void {
	const retired = new Set(retiredKeys);
	const overlap = activeKeys.find((key) => retired.has(key));
	if (overlap !== undefined) {
		throw new InvalidRequestError(`${label} ${overlap} cannot be active and retired`);
	}
}

function normalizeProviderBinding(
	binding: CatalogProviderBindingIntent,
): CatalogProviderBindingIntent {
	const expectedChannel = { apple: "ios", google: "android", stripe: "web" }[binding.provider];
	if (binding.channel !== expectedChannel) {
		throw new InvalidRequestError(
			`${binding.provider} catalog bindings must use the ${expectedChannel} channel`,
		);
	}
	return {
		...binding,
		productKey: normalizedKey(binding.productKey, "provider product key"),
	};
}

function normalizePrice(price: CatalogPriceIntent, label: string): CatalogPriceIntent {
	if (!Number.isSafeInteger(price.unitAmountMinor) || price.unitAmountMinor < 0) {
		throw new InvalidRequestError(`${label} unitAmountMinor must be a nonnegative safe integer`);
	}
	if (!Number.isSafeInteger(price.minimumQuantity) || price.minimumQuantity < 1) {
		throw new InvalidRequestError(`${label} minimumQuantity must be a positive integer`);
	}
	if (
		price.maximumQuantity !== null &&
		(!Number.isSafeInteger(price.maximumQuantity) || price.maximumQuantity < price.minimumQuantity)
	) {
		throw new InvalidRequestError(`${label} maximumQuantity must be at least minimumQuantity`);
	}
	const providerBindings = price.providerBindings
		.map(normalizeProviderBinding)
		.sort((left, right) =>
			providerBindingIdentity(left).localeCompare(providerBindingIdentity(right)),
		);
	if (providerBindings.length === 0) {
		throw new InvalidRequestError(`${label} requires at least one provider binding`);
	}
	if (providerBindings.some((binding) => binding.provider !== "stripe")) {
		throw new InvalidRequestError(
			`${label} explicit price components are currently supported only on Stripe web`,
		);
	}
	const pricingModel = price.pricingModel ?? "flat";
	const tiers = (price.tiers ?? []).map((tier) => {
		if (!Number.isSafeInteger(tier.unitAmountMinor) || tier.unitAmountMinor < 0) {
			throw new InvalidRequestError(`${label} tier unitAmountMinor must be nonnegative`);
		}
		const flatAmountMinor = tier.flatAmountMinor ?? 0;
		if (!Number.isSafeInteger(flatAmountMinor) || flatAmountMinor < 0) {
			throw new InvalidRequestError(`${label} tier flatAmountMinor must be nonnegative`);
		}
		return {
			upToQuantity:
				tier.upToQuantity === null
					? null
					: positiveDecimal(tier.upToQuantity, `${label} tier boundary`, 9),
			unitAmountMinor: tier.unitAmountMinor,
			flatAmountMinor,
		};
	});
	validateTierBoundaries(
		pricingModel,
		tiers.map(({ upToQuantity }) => upToQuantity),
		label,
	);
	return {
		...price,
		key: normalizedKey(price.key, `${label} key`),
		currency: requiredText(price.currency, `${label} currency`, 3).toUpperCase(),
		billingUnits: positiveDecimal(price.billingUnits, `${label} billingUnits`, 9),
		pricingModel,
		tiers,
		providerBindings,
	};
}

function validateTierBoundaries(
	pricingModel: "flat" | "graduated" | "volume",
	boundaries: Array<string | null>,
	label: string,
): void {
	if (pricingModel === "flat") {
		if (boundaries.length > 0)
			throw new InvalidRequestError(`${label} flat pricing cannot use tiers`);
		return;
	}
	if (boundaries.length === 0) {
		throw new InvalidRequestError(`${label} tiered pricing requires tiers`);
	}
	let previous = 0n;
	for (const [index, boundary] of boundaries.entries()) {
		if (boundary === null) {
			if (index !== boundaries.length - 1) {
				throw new InvalidRequestError(`${label} only the final tier can be unbounded`);
			}
			continue;
		}
		const units = decimalToUnits(boundary, 9);
		if (units <= previous) {
			throw new InvalidRequestError(`${label} tier boundaries must be strictly increasing`);
		}
		previous = units;
	}
	if (boundaries.at(-1) !== null) {
		throw new InvalidRequestError(`${label} final tier must be unbounded`);
	}
}

function normalizeControl(
	control: CatalogControlIntent,
	featureByKey: Map<string, CatalogFeatureIntent>,
): CatalogControlIntent {
	const limitValue = canonicalDecimal(control.limitValue, "control limitValue", 9);
	if (control.controlKind === "spend_limit") {
		if (control.featureKey !== null || control.currency === null) {
			throw new InvalidRequestError("Spend limits require currency and cannot select a feature");
		}
		if (!/^\w{3}$/.test(control.currency.trim())) {
			throw new InvalidRequestError("Spend-limit currency must be a three-letter code");
		}
		if (limitValue.includes(".")) {
			throw new InvalidRequestError("Spend limits are integer minor-unit values");
		}
		return {
			...control,
			featureKey: null,
			currency: control.currency.trim().toUpperCase(),
			limitValue,
		};
	}
	if (control.currency !== null || control.featureKey === null) {
		throw new InvalidRequestError("Usage limits require a feature and cannot declare currency");
	}
	const featureKey = normalizedKey(control.featureKey, "control feature key");
	const feature = featureByKey.get(featureKey);
	if (feature === undefined || feature.kind !== "metered") {
		throw new InvalidRequestError(`Usage limit references unknown metered feature ${featureKey}`);
	}
	return {
		...control,
		featureKey,
		currency: null,
		limitValue: canonicalDecimal(control.limitValue, "control limitValue", feature.creditScale),
	};
}

function controlIdentity(control: CatalogControlIntent): string {
	return [
		control.controlKind,
		control.featureKey ?? "",
		control.currency ?? "",
		control.interval,
	].join(":");
}

function allPlanPriceBindings(
	plan: Pick<CatalogPlanIntent, "basePrice" | "items" | "providerBindings">,
): CatalogProviderBindingIntent[] {
	const prices = [plan.basePrice ?? null, ...plan.items.map((item) => item.price ?? null)].filter(
		(price): price is CatalogPriceIntent => price !== null,
	);
	return prices.length === 0
		? plan.providerBindings
		: prices.flatMap((price) => price.providerBindings);
}

function providerBindingIdentity(binding: CatalogProviderBindingIntent): string {
	return `${binding.provider}:${binding.channel}:${binding.productKey}`;
}

function validateFeature(feature: CatalogFeatureIntent): void {
	if (
		!Number.isInteger(feature.creditScale) ||
		feature.creditScale < 0 ||
		feature.creditScale > 9
	) {
		throw new InvalidRequestError(`Feature ${feature.key} creditScale must be between 0 and 9`);
	}
	if (feature.filterDimensions.length > 8) {
		throw new InvalidRequestError(`Feature ${feature.key} declares too many filter dimensions`);
	}
	if (feature.kind === "boolean" && (feature.meterKind !== null || feature.creditScale !== 0)) {
		throw new InvalidRequestError(`Boolean feature ${feature.key} cannot declare meter semantics`);
	}
	if (feature.kind === "metered" && feature.meterKind === null) {
		throw new InvalidRequestError(`Metered feature ${feature.key} requires meterKind`);
	}
}

async function calculateImpact(
	executor: QueryExecutor,
	projectId: string,
	catalog: CatalogIntent,
): Promise<CatalogImpact> {
	const featureRows = await executeRows<{ key: string; active: boolean }>(
		executor,
		drizzleSql`SELECT key, active FROM features WHERE project_id = ${projectId}`,
	);
	const planRows = await executeRows<{ key: string; active: boolean }>(
		executor,
		drizzleSql`SELECT key, active FROM plans WHERE project_id = ${projectId}`,
	);
	const existingFeatures = new Set(featureRows.map(({ key }) => key));
	const existingPlans = new Set(planRows.map(({ key }) => key));
	const currentCatalog = await readCurrentCatalogIntent(executor, projectId);
	const planVersionsCreated = changedPlans(currentCatalog, catalog).length;
	const currentTopups = new Set((currentCatalog?.topups ?? []).map(({ key }) => key));
	const retiredFeatures = new Set(catalog.retiredFeatureKeys ?? []);
	const retiredPlans = new Set(catalog.retiredPlanKeys ?? []);
	const retiredTopups = new Set(catalog.retiredTopupKeys ?? []);
	const grandfathered = await executeOne<{ count: number | string }>(
		executor,
		drizzleSql`
			SELECT count(*)::text AS count
			FROM subscriptions
			WHERE project_id = ${projectId}
				AND plan_version_id IS NOT NULL
		`,
	);
	return {
		featuresCreated: catalog.features.filter(({ key }) => !existingFeatures.has(key)).length,
		featuresReused: catalog.features.filter(({ key }) => existingFeatures.has(key)).length,
		featuresRetired: featureRows.filter(({ key, active }) => active && retiredFeatures.has(key))
			.length,
		plansCreated: catalog.plans.filter(({ key }) => !existingPlans.has(key)).length,
		planVersionsCreated,
		plansRetired: planRows.filter(({ key, active }) => active && retiredPlans.has(key)).length,
		topupOptionsCreated: catalog.topups.length,
		topupsRetired: [...currentTopups].filter((key) => retiredTopups.has(key)).length,
		providerBindingsValidated: changedPlans(currentCatalog, catalog).reduce(
			(total, plan) => total + allPlanPriceBindings(plan).length,
			catalog.topups.reduce((total, topup) => total + topup.providerBindings.length, 0),
		),
		existingSubscriptionsGrandfathered: Number(grandfathered?.count ?? 0),
	};
}

function changedPlans(
	currentCatalog: CatalogIntent | null,
	nextCatalog: CatalogIntent,
): CatalogPlanIntent[] {
	const currentPlans = new Map(
		(currentCatalog?.plans ?? []).map((plan) => [plan.key, stableJson(plan)]),
	);
	return nextCatalog.plans.filter((plan) => currentPlans.get(plan.key) !== stableJson(plan));
}

async function validateCatalogLifecycle(
	executor: QueryExecutor,
	projectId: string,
	catalog: CatalogIntent,
): Promise<void> {
	const featureRows = await executeRows<{ key: string; active: boolean }>(
		executor,
		drizzleSql`SELECT key, active FROM features WHERE project_id = ${projectId}`,
	);
	const planRows = await executeRows<{ key: string; active: boolean }>(
		executor,
		drizzleSql`SELECT key, active FROM plans WHERE project_id = ${projectId}`,
	);
	const topupRows = await executeRows<{ key: string }>(
		executor,
		drizzleSql`SELECT DISTINCT key FROM topup_options WHERE project_id = ${projectId}`,
	);
	const activeFeatureKeys = new Set(catalog.features.map(({ key }) => key));
	const activePlanKeys = new Set(catalog.plans.map(({ key }) => key));
	const activeTopupKeys = new Set(catalog.topups.map(({ key }) => key));
	const retiredFeatureKeys = new Set(catalog.retiredFeatureKeys ?? []);
	const retiredPlanKeys = new Set(catalog.retiredPlanKeys ?? []);
	const retiredTopupKeys = new Set(catalog.retiredTopupKeys ?? []);
	assertKnownRetirements(retiredFeatureKeys, new Set(featureRows.map(({ key }) => key)), "feature");
	assertKnownRetirements(retiredPlanKeys, new Set(planRows.map(({ key }) => key)), "plan");
	assertKnownRetirements(retiredTopupKeys, new Set(topupRows.map(({ key }) => key)), "top-up");
	for (const row of featureRows) {
		if (row.active && !activeFeatureKeys.has(row.key) && !retiredFeatureKeys.has(row.key)) {
			throw new InvalidRequestError(
				`Active feature ${row.key} must remain in the catalog or be explicitly retired`,
			);
		}
	}
	for (const row of planRows) {
		if (row.active && !activePlanKeys.has(row.key) && !retiredPlanKeys.has(row.key)) {
			throw new InvalidRequestError(
				`Active plan ${row.key} must remain in the catalog or be explicitly retired`,
			);
		}
	}
	const currentCatalog = await readCurrentCatalogIntent(executor, projectId);
	for (const topup of currentCatalog?.topups ?? []) {
		if (!activeTopupKeys.has(topup.key) && !retiredTopupKeys.has(topup.key)) {
			throw new InvalidRequestError(
				`Active top-up ${topup.key} must remain in the catalog or be explicitly retired`,
			);
		}
	}
}

function assertKnownRetirements(
	retiredKeys: Set<string>,
	knownKeys: Set<string>,
	label: string,
): void {
	const unknown = [...retiredKeys].find((key) => !knownKeys.has(key));
	if (unknown !== undefined) {
		throw new InvalidRequestError(`Cannot retire unknown ${label} ${unknown}`);
	}
}

async function readCurrentCatalogIntent(
	executor: QueryExecutor,
	projectId: string,
): Promise<CatalogIntent | null> {
	const row = await executeOne<{ intent: CatalogIntent }>(
		executor,
		drizzleSql`
			SELECT draft.intent
			FROM projects project
			JOIN catalog_revisions revision
				ON revision.project_id = project.id
				AND revision.id = project.published_catalog_revision_id
			JOIN catalog_drafts draft
				ON draft.project_id = revision.project_id
				AND draft.published_revision_id = revision.id
				AND draft.status = 'published'
			WHERE project.id = ${projectId}
		`,
	);
	return row === null ? null : normalizeCatalog(row.intent);
}

async function applyCatalogRetirements(
	executor: QueryExecutor,
	projectId: string,
	catalog: CatalogIntent,
): Promise<void> {
	const retiredPlanKeys = catalog.retiredPlanKeys ?? [];
	if (retiredPlanKeys.length > 0) {
		await executeRows(
			executor,
			drizzleSql`
				UPDATE plans
				SET active = false, updated_at = now()
				WHERE project_id = ${projectId}
					AND key IN (SELECT jsonb_array_elements_text(${jsonb(retiredPlanKeys)}))
				RETURNING id
			`,
		);
	}
	const retiredFeatureKeys = catalog.retiredFeatureKeys ?? [];
	if (retiredFeatureKeys.length > 0) {
		await executeRows(
			executor,
			drizzleSql`
				UPDATE features
				SET active = false, updated_at = now()
				WHERE project_id = ${projectId}
					AND key IN (SELECT jsonb_array_elements_text(${jsonb(retiredFeatureKeys)}))
				RETURNING id
			`,
		);
	}
}

async function publishFeatures(
	executor: QueryExecutor,
	projectId: string,
	features: CatalogFeatureIntent[],
): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	for (const feature of features) {
		const row = await executeOne<{ id: string | number | bigint }>(
			executor,
			drizzleSql`
				INSERT INTO features (
					project_id, key, name, kind, meter_kind, unit, credit_scale, filter_dimensions
				)
				VALUES (
					${projectId}, ${feature.key}, ${feature.name}, ${feature.kind},
					${feature.meterKind}, ${feature.unit}, ${feature.creditScale},
					ARRAY(SELECT jsonb_array_elements_text(${jsonb(feature.filterDimensions)}))
				)
				ON CONFLICT (project_id, key) DO UPDATE SET
					name = EXCLUDED.name,
					active = true,
					updated_at = now()
				WHERE features.kind = EXCLUDED.kind
					AND features.meter_kind IS NOT DISTINCT FROM EXCLUDED.meter_kind
					AND features.unit = EXCLUDED.unit
					AND features.credit_scale = EXCLUDED.credit_scale
					AND features.filter_dimensions = EXCLUDED.filter_dimensions
				RETURNING id
			`,
		);
		if (row === null) {
			throw new PersistenceConflictError(
				`Feature ${feature.key} changes immutable meter semantics`,
				"FEATURE_IDENTITY_CONFLICT",
			);
		}
		ids.set(feature.key, String(row.id));
	}
	return ids;
}

async function publishPlans(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	catalog: CatalogIntent,
	featureIds: Map<string, string>,
): Promise<{ versionIds: Map<string, string>; priceComponentIds: Map<string, string> }> {
	const versionIds = new Map<string, string>();
	const priceComponentIds = new Map<string, string>();
	for (const plan of catalog.plans) {
		const customerId = await resolveCustomPlanCustomerId(
			executor,
			projectId,
			plan.visibility ?? "public",
			plan.customerBillingAccountId ?? null,
		);
		const stablePlan = await executeOne<{ id: string | number | bigint }>(
			executor,
			drizzleSql`
				INSERT INTO plans (project_id, key, name)
				VALUES (${projectId}, ${plan.key}, ${plan.name})
				ON CONFLICT (project_id, key) DO UPDATE SET
					name = EXCLUDED.name,
					active = true,
					updated_at = now()
				RETURNING id
			`,
		);
		if (stablePlan === null) throw new Error(`Plan ${plan.key} could not be persisted`);
		const version = await executeOne<{ id: string | number | bigint }>(
			executor,
			drizzleSql`
				INSERT INTO plan_versions (
					project_id, plan_id, catalog_revision_id, version, status,
					currency, base_amount_minor, billing_interval, trial_days,
					plan_kind, tier_rank, trial_requires_payment_method, trial_end_behavior,
					upgrade_proration_behavior, downgrade_proration_behavior,
					visibility, customer_id
				)
				VALUES (
					${projectId}, ${String(stablePlan.id)}::bigint, ${revisionId}::bigint,
					${plan.version}, 'published', ${plan.currency}, ${plan.baseAmountMinor},
					${plan.billingInterval}, ${plan.trialDays}, ${plan.kind ?? "base"},
					${plan.tierRank ?? 0}, ${plan.trialRequiresPaymentMethod ?? true},
					${plan.trialEndBehavior ?? "cancel"},
					${plan.upgradeProrationBehavior ?? "always_invoice"},
					${plan.downgradeProrationBehavior ?? "none"},
					${plan.visibility ?? "public"}, ${customerId}
				)
				ON CONFLICT (project_id, plan_id, version) DO NOTHING
				RETURNING id
			`,
		);
		if (version === null) {
			throw new PersistenceConflictError(
				`Plan ${plan.key} version ${plan.version} already exists`,
				"PLAN_VERSION_CONFLICT",
			);
		}
		const versionId = String(version.id);
		versionIds.set(plan.key, versionId);
		const planItemIds = new Map<string, string>();
		for (const item of plan.items) {
			const persistedItem = await executeOne<{ id: string | number | bigint }>(
				executor,
				drizzleSql`
					INSERT INTO plan_items (
						project_id, plan_version_id, feature_id, item_kind, quantity,
						reset_interval, expires_after_seconds, overage_policy, allocation_scope,
						rollover_enabled, rollover_max_quantity, rollover_expiry_mode,
						rollover_expiry_months
					)
					VALUES (
						${projectId}, ${versionId}::bigint, ${requireMap(featureIds, item.featureKey)}::bigint,
						${item.itemKind}, ${item.quantity}::numeric, ${item.resetInterval},
						${item.expiresAfterSeconds}, ${item.overagePolicy},
						${item.allocationScope ?? "account"}, ${item.rollover !== null},
						${item.rollover?.maxQuantity ?? null}::numeric,
						${item.rollover?.expiry.mode ?? "none"},
						${item.rollover?.expiry.mode === "months" ? item.rollover.expiry.months : null}
					)
					RETURNING id
				`,
			);
			if (persistedItem === null)
				throw new Error(`Plan item ${item.featureKey} could not be persisted`);
			planItemIds.set(item.featureKey, String(persistedItem.id));
		}
		const prices = [
			...(plan.basePrice === undefined || plan.basePrice === null
				? []
				: [{ price: plan.basePrice, componentKind: "base" as const, planItemId: null }]),
			...plan.items.flatMap((item) =>
				item.price === undefined || item.price === null
					? []
					: [
							{
								price: item.price,
								componentKind:
									item.itemKind === "licensed_quantity"
										? ("licensed" as const)
										: ("metered_overage" as const),
								planItemId: requireMap(planItemIds, item.featureKey),
							},
						],
			),
		];
		for (const component of prices) {
			const persistedPrice = await executeOne<{ id: string | number | bigint }>(
				executor,
				drizzleSql`
					INSERT INTO price_components (
						project_id, plan_version_id, plan_item_id, key, component_kind,
						charge_timing, currency, unit_amount_minor, billing_units,
						billing_interval, minimum_quantity, maximum_quantity, tax_behavior,
						pricing_model
					)
					VALUES (
						${projectId}, ${versionId}::bigint, ${component.planItemId}::bigint,
						${component.price.key}, ${component.componentKind},
						${component.componentKind === "metered_overage" ? "in_arrears" : "in_advance"},
						${component.price.currency}, ${component.price.unitAmountMinor},
						${component.price.billingUnits}::numeric, ${component.price.billingInterval},
						${component.price.minimumQuantity}, ${component.price.maximumQuantity},
						${component.price.taxBehavior}, ${component.price.pricingModel ?? "flat"}
					)
					RETURNING id
				`,
			);
			if (persistedPrice === null)
				throw new Error(`Price ${component.price.key} could not be persisted`);
			priceComponentIds.set(`${plan.key}:${component.price.key}`, String(persistedPrice.id));
			for (const [ordinal, tier] of (component.price.tiers ?? []).entries()) {
				await executeOne(
					executor,
					drizzleSql`
						INSERT INTO price_tiers (
							project_id, price_component_id, ordinal, up_to_quantity,
							unit_amount_minor, flat_amount_minor
						)
						VALUES (
							${projectId}, ${String(persistedPrice.id)}::bigint, ${ordinal},
							${tier.upToQuantity}::numeric, ${tier.unitAmountMinor},
							${tier.flatAmountMinor ?? 0}
						)
						RETURNING id
					`,
				);
			}
		}
		for (const control of plan.controls ?? []) {
			await executeOne(
				executor,
				drizzleSql`
					INSERT INTO control_policies (
						project_id, source_type, plan_version_id, control_kind, feature_id,
						currency, limit_value, interval, revision, created_by
					)
					VALUES (
						${projectId}, 'plan_default', ${versionId}::bigint, ${control.controlKind},
						${control.featureKey === null ? null : requireMap(featureIds, control.featureKey)}::bigint,
						${control.currency}, ${control.limitValue}::numeric, ${control.interval},
						${plan.version}, 'catalog'
					)
					RETURNING id
				`,
			);
		}
		await executeOne(
			executor,
			drizzleSql`
				UPDATE plans
				SET active_version_id = ${versionId}::bigint, updated_at = now()
				WHERE project_id = ${projectId} AND id = ${String(stablePlan.id)}::bigint
				RETURNING id
			`,
		);
	}
	return { versionIds, priceComponentIds };
}

async function publishRateCards(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	catalog: CatalogIntent,
	featureIds: Map<string, string>,
): Promise<void> {
	for (const entry of catalog.rateCards) {
		const persisted = await executeOne<{ id: string | number | bigint }>(
			executor,
			drizzleSql`
				INSERT INTO rate_card_entries (
					project_id, catalog_revision_id, meter_feature_id, wallet_feature_id,
					rate_per_unit, pricing_model
				)
				VALUES (
					${projectId}, ${revisionId}::bigint,
					${requireMap(featureIds, entry.meterFeatureKey)}::bigint,
					${requireMap(featureIds, entry.walletFeatureKey)}::bigint,
					${canonicalDecimal(entry.ratePerUnit, "ratePerUnit", 18)}::numeric,
					${entry.pricingModel ?? "flat"}
				)
				RETURNING id
			`,
		);
		if (persisted === null) throw new Error("Rate-card entry could not be persisted");
		for (const [ordinal, tier] of (entry.tiers ?? []).entries()) {
			await executeOne(
				executor,
				drizzleSql`
					INSERT INTO rate_card_tiers (
						project_id, rate_card_entry_id, ordinal, up_to_quantity, rate_per_unit
					)
					VALUES (
						${projectId}, ${String(persisted.id)}::bigint, ${ordinal},
						${tier.upToQuantity}::numeric, ${tier.ratePerUnit}::numeric
					)
					RETURNING id
				`,
			);
		}
	}
}

async function resolveCustomPlanCustomerId(
	executor: QueryExecutor,
	projectId: string,
	visibility: "public" | "customer_specific",
	billingAccountId: string | null,
): Promise<string | null> {
	if (visibility === "public") return null;
	if (billingAccountId === null) throw new InvalidRequestError("Custom plan customer is required");
	const customer = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			SELECT id
			FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
		`,
	);
	if (customer === null) {
		throw new InvalidRequestError(`Custom plan customer ${billingAccountId} was not found`);
	}
	return customer.id;
}

async function publishProviderBindings(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	catalog: CatalogIntent,
	planVersionIds: Map<string, string>,
): Promise<void> {
	for (const plan of catalog.plans) {
		for (const binding of plan.providerBindings) {
			const storeProduct = await executeOne<{ id: string }>(
				executor,
				drizzleSql`
					SELECT sp.id
					FROM store_products sp
					JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
					WHERE sp.project_id = ${projectId}
						AND p.key = ${normalizedKey(binding.productKey, "provider product key")}
						AND sp.provider = ${binding.provider}
						AND sp.channel = ${binding.channel}
						AND sp.active = true
						AND p.active = true
						AND p.type = 'subscription'
					LIMIT 1
				`,
			);
			if (storeProduct === null) {
				throw new BillingError(
					`Provider binding ${binding.provider}/${binding.channel}/${binding.productKey} is not ready`,
					"PROVIDER_BINDING_NOT_READY",
					409,
					{ classification: "persistence_conflict" },
				);
			}
			await recordProviderAdoption(executor, {
				projectId,
				revisionId,
				provider: binding.provider,
				channel: binding.channel,
				action: "adopt_plan",
				storeProductId: storeProduct.id,
			});
			await executeOne(
				executor,
				drizzleSql`
					INSERT INTO provider_plan_bindings (
						project_id, plan_version_id, store_product_id, provider, channel, status
					)
					VALUES (
						${projectId}, ${requireMap(planVersionIds, plan.key)}::bigint,
						${storeProduct.id}, ${binding.provider}, ${binding.channel}, 'published'
					)
					ON CONFLICT (project_id, store_product_id) DO UPDATE SET
						plan_version_id = EXCLUDED.plan_version_id,
						provider = EXCLUDED.provider,
						channel = EXCLUDED.channel,
						status = 'published',
						error = NULL,
						updated_at = now()
					RETURNING id
				`,
			);
		}
	}
}

async function publishProviderPriceBindings(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	catalog: CatalogIntent,
	priceComponentIds: Map<string, string>,
): Promise<void> {
	for (const plan of catalog.plans) {
		const prices = [
			...(plan.basePrice === undefined || plan.basePrice === null ? [] : [plan.basePrice]),
			...plan.items.flatMap((item) =>
				item.price === undefined || item.price === null ? [] : [item.price],
			),
		];
		for (const price of prices) {
			for (const binding of price.providerBindings) {
				const storeProduct = await executeOne<{
					id: string;
					price_amount: number | string | null;
					currency: string | null;
					billing_period: string | null;
				}>(
					executor,
					drizzleSql`
						SELECT sp.id, sp.price_amount, sp.currency, sp.billing_period
						FROM store_products sp
						JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
						WHERE sp.project_id = ${projectId}
							AND p.key = ${binding.productKey}
							AND sp.provider = ${binding.provider}
							AND sp.channel = ${binding.channel}
							AND sp.active = true
							AND p.active = true
							AND p.type = 'subscription'
						LIMIT 1
					`,
				);
				if (
					storeProduct === null ||
					((price.pricingModel ?? "flat") === "flat" &&
						Number(storeProduct.price_amount) !== price.unitAmountMinor) ||
					storeProduct.currency?.toUpperCase() !== price.currency ||
					storeProduct.billing_period !== price.billingInterval
				) {
					throw new BillingError(
						`Price binding ${binding.provider}/${binding.channel}/${binding.productKey} does not match ${plan.key}/${price.key}`,
						"PROVIDER_BINDING_NOT_READY",
						409,
						{ classification: "persistence_conflict" },
					);
				}
				await recordProviderAdoption(executor, {
					projectId,
					revisionId,
					provider: binding.provider,
					channel: binding.channel,
					action: "adopt_price",
					storeProductId: storeProduct.id,
				});
				await executeOne(
					executor,
					drizzleSql`
						INSERT INTO provider_price_bindings (
							project_id, price_component_id, store_product_id, provider, channel, status
						)
						VALUES (
							${projectId}, ${requireMap(priceComponentIds, `${plan.key}:${price.key}`)}::bigint,
							${storeProduct.id}, ${binding.provider}, ${binding.channel}, 'published'
						)
						RETURNING id
					`,
				);
			}
		}
	}
}

async function publishTopupOptions(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	catalog: CatalogIntent,
	featureIds: Map<string, string>,
): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	for (const topup of catalog.topups) {
		const row = await executeOne<{ id: string | number | bigint }>(
			executor,
			drizzleSql`
				INSERT INTO topup_options (
					project_id,
					catalog_revision_id,
					key,
					feature_id,
					quantity,
					expires_after_seconds
				)
				VALUES (
					${projectId},
					${revisionId}::bigint,
					${topup.key},
					${requireMap(featureIds, topup.featureKey)}::bigint,
					${topup.quantity}::numeric,
					${topup.expiresAfterSeconds}
				)
				RETURNING id
			`,
		);
		if (row === null) throw new Error(`Top-up ${topup.key} could not be persisted`);
		ids.set(topup.key, String(row.id));
	}
	return ids;
}

async function publishTopupProviderBindings(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	catalog: CatalogIntent,
	topupOptionIds: Map<string, string>,
): Promise<void> {
	for (const topup of catalog.topups) {
		for (const binding of topup.providerBindings) {
			const storeProduct = await executeOne<{ id: string }>(
				executor,
				drizzleSql`
					SELECT sp.id
					FROM store_products sp
					JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
					WHERE sp.project_id = ${projectId}
						AND p.key = ${binding.productKey}
						AND sp.provider = ${binding.provider}
						AND sp.channel = ${binding.channel}
						AND sp.active = true
						AND p.active = true
						AND p.type = 'consumable'
					LIMIT 1
				`,
			);
			if (storeProduct === null) {
				throw new BillingError(
					`Top-up binding ${binding.provider}/${binding.channel}/${binding.productKey} is not ready`,
					"PROVIDER_BINDING_NOT_READY",
					409,
					{ classification: "persistence_conflict" },
				);
			}
			await recordProviderAdoption(executor, {
				projectId,
				revisionId,
				provider: binding.provider,
				channel: binding.channel,
				action: "adopt_topup",
				storeProductId: storeProduct.id,
			});
			await executeOne(
				executor,
				drizzleSql`
					INSERT INTO provider_topup_bindings (
						project_id, topup_option_id, store_product_id, provider, channel, status
					)
					VALUES (
						${projectId}, ${requireMap(topupOptionIds, topup.key)}::bigint,
						${storeProduct.id}, ${binding.provider}, ${binding.channel}, 'published'
					)
					ON CONFLICT (project_id, store_product_id) DO UPDATE SET
						topup_option_id = EXCLUDED.topup_option_id,
						provider = EXCLUDED.provider,
						channel = EXCLUDED.channel,
						status = 'published',
						error = NULL,
						updated_at = now()
					RETURNING id
				`,
			);
		}
	}
}

async function recordProviderAdoption(
	executor: QueryExecutor,
	input: {
		projectId: string;
		revisionId: string;
		provider: "apple" | "google" | "stripe";
		channel: "ios" | "android" | "web";
		action: "adopt_plan" | "adopt_topup" | "adopt_price";
		storeProductId: string;
	},
): Promise<void> {
	const operationKey = [
		"catalog",
		input.revisionId,
		input.action,
		input.provider,
		input.channel,
		input.storeProductId,
	].join(":");
	await executeOne(
		executor,
		drizzleSql`
			INSERT INTO catalog_provider_operations (
				project_id,
				catalog_revision_id,
				provider,
				channel,
				action,
				operation_key,
				store_product_id,
				status,
				attempts,
				completed_at
			)
			VALUES (
				${input.projectId},
				${input.revisionId}::bigint,
				${input.provider},
				${input.channel},
				${input.action},
				${operationKey},
				${input.storeProductId},
				'ready',
				1,
				now()
			)
			RETURNING id
		`,
	);
}

async function readPublishedResult(
	executor: QueryExecutor,
	projectId: string,
	revisionId: string,
	duplicate: boolean,
): Promise<CatalogPublishResult> {
	const row = await executeOne<{
		revision: number;
		intent_hash: string;
		published_at: Date | string;
		metadata: { impact?: CatalogImpact };
	}>(
		executor,
		drizzleSql`
			SELECT revision, intent_hash, published_at, metadata
			FROM catalog_revisions
			WHERE project_id = ${projectId} AND id = ${revisionId}::bigint
		`,
	);
	if (row === null || row.published_at === null) throw new Error("Published catalog was not found");
	return {
		revisionId,
		revision: row.revision,
		intentHash: row.intent_hash,
		publishedAt: toIso(row.published_at),
		duplicate,
		impact: row.metadata.impact ?? {
			featuresCreated: 0,
			featuresReused: 0,
			featuresRetired: 0,
			plansCreated: 0,
			planVersionsCreated: 0,
			plansRetired: 0,
			topupOptionsCreated: 0,
			topupsRetired: 0,
			providerBindingsValidated: 0,
			existingSubscriptionsGrandfathered: 0,
		},
	};
}

function normalizedKey(value: string, field: string): string {
	const normalized = value.trim();
	if (!/^[a-z][a-z0-9_:-]{0,119}$/.test(normalized)) {
		throw new InvalidRequestError(`${field} must be a lowercase stable key`);
	}
	return normalized;
}

function requiredText(value: string, field: string, max: number): string {
	const normalized = value.trim();
	if (normalized === "" || normalized.length > max) {
		throw new InvalidRequestError(`${field} must contain between 1 and ${max} characters`);
	}
	return normalized;
}

function requireActor(value: string): string {
	return requiredText(value, "actor", 200);
}

function assertUnique(values: string[], field: string): void {
	if (new Set(values).size !== values.length) {
		throw new InvalidRequestError(`Duplicate ${field} values are not allowed`);
	}
}

function requireMap(map: Map<string, string>, key: string): string {
	const value = map.get(key);
	if (value === undefined) throw new Error(`Catalog reference ${key} was not resolved`);
	return value;
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
