import { sql as drizzleSql } from "drizzle-orm";
import type {
	AutoTopupPolicyInput,
	AutoTopupPolicyRecord,
	CatalogMigrationInput,
	CatalogMigrationPreview,
	CatalogMigrationResult,
	ControlInterval,
	ControlPolicyInput,
	ControlsEnterpriseRepositoryLike,
	EffectiveControl,
	EnterpriseContractInput,
	EnterpriseContractPreview,
	EnterpriseContractRecord,
	EntityLicenseDecision,
	EntityRecord,
	LicenseAssignmentRecord,
	LicensePoolRecord,
	UsageAlertEvent,
	UsageAlertInput,
	UsageAlertRecord,
} from "../../billing/controls";
import {
	canonicalDecimal,
	decimalToUnits,
	sha256Hex,
	stableJson,
	unitsToDecimal,
} from "../../billing/decimal";
import {
	InvalidRequestError,
	NotFoundBillingError,
	PersistenceConflictError,
} from "../../billing/errors";
import type { ProjectInstanceContext } from "../../projects/context";
import { toIso } from "../../shared/date";
import { RepositoryModule } from "./base";
import { ensureCustomer } from "./identities";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

interface EffectiveControlRow {
	id: string | number | bigint;
	source_type: EffectiveControl["source"];
	control_kind: EffectiveControl["controlKind"];
	feature_key: string | null;
	currency: string | null;
	limit_value: unknown;
	interval: ControlInterval;
	revision: number;
	contract_replaces_defaults: boolean | null;
}

export class ControlsEnterpriseRepository
	extends RepositoryModule
	implements ControlsEnterpriseRepositoryLike
{
	async upsertControl(
		project: ProjectInstanceContext,
		input: ControlPolicyInput,
	): Promise<EffectiveControl> {
		const persisted = await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await ensureCustomer(
				tx,
				projectId,
				requiredText(input.billingAccountId, "billingAccountId", 200),
			);
			const entity = await resolveEntity(tx, projectId, customer.id, input.entityId ?? null);
			const normalized = await normalizeControlInput(tx, projectId, input);
			await executeOne(
				tx,
				drizzleSql`SELECT id FROM customers WHERE id = ${customer.id} FOR UPDATE`,
			);
			const revisionRow = await executeOne<{ revision: number }>(
				tx,
				drizzleSql`
					SELECT COALESCE(max(revision), 0)::integer + 1 AS revision
					FROM control_policies
					WHERE project_id = ${projectId}
						AND source_type = ${entity === null ? "account" : "entity"}
						AND customer_id = ${customer.id}
						AND entity_id IS NOT DISTINCT FROM ${entity?.id ?? null}::bigint
				`,
			);
			const revision = revisionRow?.revision ?? 1;
			await executeRows(
				tx,
				drizzleSql`
					UPDATE control_policies
					SET active = false, updated_at = now()
					WHERE project_id = ${projectId}
						AND source_type = ${entity === null ? "account" : "entity"}
						AND customer_id = ${customer.id}
						AND entity_id IS NOT DISTINCT FROM ${entity?.id ?? null}::bigint
						AND control_kind = ${normalized.controlKind}
						AND feature_id IS NOT DISTINCT FROM ${normalized.featureId}::bigint
						AND currency IS NOT DISTINCT FROM ${normalized.currency}
						AND active = true
				`,
			);
			const policy = await executeOne<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
					INSERT INTO control_policies (
						project_id, source_type, customer_id, entity_id, control_kind,
						feature_id, currency, limit_value, interval, revision, created_by
					)
					VALUES (
						${projectId}, ${entity === null ? "account" : "entity"}, ${customer.id},
						${entity?.id ?? null}::bigint, ${normalized.controlKind},
						${normalized.featureId}::bigint, ${normalized.currency},
						${normalized.limitValue}::numeric, ${normalized.interval}, ${revision},
						${requiredText(input.actor, "actor", 200)}
					)
					RETURNING id
				`,
			);
			if (policy === null) throw new Error("Control policy could not be persisted");
			await insertAudit(tx, projectId, "control_changed", input.actor, {
				policyId: String(policy.id),
				billingAccountId: input.billingAccountId,
				entityId: input.entityId ?? null,
				revision,
			});
			return {
				projectId,
				customerId: customer.id,
				entityId: entity?.id ?? null,
				policyId: String(policy.id),
				normalized,
			};
		});
		const controls = await resolveEffectiveControls(this.database, {
			projectId: persisted.projectId,
			customerId: persisted.customerId,
			entityId: persisted.entityId,
		});
		return (
			controls.find((control) => control.policyId === persisted.policyId) ??
			controls.find(
				(control) =>
					control.controlKind === persisted.normalized.controlKind &&
					control.featureKey === persisted.normalized.featureKey &&
					control.currency === persisted.normalized.currency,
			) ??
			(() => {
				throw new Error("Effective control could not be resolved");
			})()
		);
	}

	async listEffectiveControls(
		project: ProjectInstanceContext,
		billingAccountId: string,
		entityId?: string | null,
	): Promise<EffectiveControl[]> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, billingAccountId);
		const entity = await resolveEntity(this.database, projectId, customer.id, entityId ?? null);
		return await resolveEffectiveControls(this.database, {
			projectId,
			customerId: customer.id,
			entityId: entity?.id ?? null,
		});
	}

	async createEntity(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			externalId: string;
			kind: string;
			metadata?: Record<string, unknown>;
		},
	): Promise<EntityRecord> {
		const projectId = project.projectInstanceId;
		const customer = await ensureCustomer(
			this.database,
			projectId,
			requiredText(input.billingAccountId, "billingAccountId", 200),
		);
		const row = await executeOne<EntityDbRow>(
			this.database,
			drizzleSql`
				INSERT INTO entities (project_id, customer_id, external_id, kind, metadata)
				VALUES (
					${projectId}, ${customer.id}, ${requiredText(input.externalId, "entityId", 200)},
					${requiredText(input.kind, "kind", 120)}, ${jsonb(input.metadata ?? {})}
				)
				ON CONFLICT (project_id, customer_id, external_id) DO UPDATE SET
					kind = EXCLUDED.kind, metadata = EXCLUDED.metadata, updated_at = now()
				RETURNING id, external_id, kind, metadata, created_at, updated_at
			`,
		);
		if (row === null) throw new Error("Entity could not be persisted");
		return entityRecord(row);
	}

	async listEntities(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<EntityRecord[]> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, billingAccountId);
		const rows = await executeRows<EntityDbRow>(
			this.database,
			drizzleSql`
				SELECT id, external_id, kind, metadata, created_at, updated_at
				FROM entities
				WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				ORDER BY created_at, id
			`,
		);
		return rows.map(entityRecord);
	}

	async createUsageAlert(
		project: ProjectInstanceContext,
		input: UsageAlertInput,
	): Promise<UsageAlertRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
			const entity = await resolveEntity(tx, projectId, customer.id, input.entityId ?? null);
			const feature = await requireFeature(tx, projectId, input.featureKey);
			const threshold = canonicalDecimal(input.thresholdValue, "thresholdValue", 9);
			if (decimalToUnits(threshold, 9) <= 0n)
				throw new InvalidRequestError("thresholdValue must be positive");
			if (input.thresholdType === "percentage" && decimalToUnits(threshold, 9) > 100n * 10n ** 9n) {
				throw new InvalidRequestError("Percentage threshold cannot exceed 100");
			}
			let evaluatedThreshold = threshold;
			if (input.thresholdType === "percentage") {
				const control = (
					await resolveEffectiveControls(tx, {
						projectId,
						customerId: customer.id,
						entityId: entity?.id ?? null,
					})
				).find((item) => item.controlKind === "usage_limit" && item.featureKey === feature.key);
				if (control === undefined) {
					throw new InvalidRequestError("Percentage alerts require an effective usage limit");
				}
				evaluatedThreshold = unitsToDecimal(
					(decimalToUnits(control.limitValue, 9) * decimalToUnits(threshold, 9)) /
						(100n * 10n ** 9n),
					9,
				);
			}
			const row = await executeOne<AlertDbRow>(
				tx,
				drizzleSql`
					INSERT INTO usage_alerts (
						project_id, customer_id, entity_id, feature_id, threshold_type,
						threshold_value, interval, created_by, metadata
					)
					VALUES (
						${projectId}, ${customer.id}, ${entity?.id ?? null}::bigint,
						${feature.id}::bigint, ${input.thresholdType}, ${threshold}::numeric,
						${input.interval}, ${requiredText(input.actor, "actor", 200)},
						${jsonb(input.metadata ?? {})}
					)
					RETURNING id, entity_id, threshold_type, threshold_value, interval, active, created_at
				`,
			);
			if (row === null) throw new Error("Usage alert could not be persisted");
			const bounds = controlWindowBounds(input.interval, new Date());
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO usage_alert_states (
						project_id, alert_id, window_start_at, window_end_at, threshold_value
					)
					VALUES (
						${projectId}, ${String(row.id)}::bigint, ${bounds.start.toISOString()},
						${bounds.end?.toISOString() ?? null}, ${evaluatedThreshold}::numeric
					)
					RETURNING alert_id
				`,
			);
			return alertRecord(row, feature.key, entity?.external_id ?? null, "0", false);
		});
	}

	async listUsageAlerts(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<UsageAlertRecord[]> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, billingAccountId);
		const rows = await executeRows<
			AlertDbRow & {
				feature_key: string;
				entity_external_id: string | null;
				current_value: unknown;
				crossed: boolean;
			}
		>(
			this.database,
			drizzleSql`
				SELECT alert.id, alert.entity_id, alert.threshold_type, alert.threshold_value,
					alert.interval, alert.active, alert.created_at, feature.key AS feature_key,
					entity.external_id AS entity_external_id,
					COALESCE(state.current_value, 0)::text AS current_value,
					COALESCE(state.crossed, false) AS crossed
				FROM usage_alerts alert
				JOIN features feature ON feature.project_id = alert.project_id AND feature.id = alert.feature_id
				LEFT JOIN entities entity ON entity.project_id = alert.project_id AND entity.id = alert.entity_id
				LEFT JOIN usage_alert_states state ON state.project_id = alert.project_id AND state.alert_id = alert.id
				WHERE alert.project_id = ${projectId} AND alert.customer_id = ${customer.id}
				ORDER BY alert.created_at, alert.id
			`,
		);
		return rows.map((row) =>
			alertRecord(
				row,
				row.feature_key,
				row.entity_external_id,
				String(row.current_value),
				row.crossed,
			),
		);
	}

	async listUsageAlertEvents(
		project: ProjectInstanceContext,
		billingAccountId: string,
		limit: number,
	): Promise<UsageAlertEvent[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 500)
			throw new InvalidRequestError("limit must be between 1 and 500");
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, billingAccountId);
		const rows = await executeRows<{
			id: string | number | bigint;
			alert_id: string | number | bigint;
			entity_external_id: string | null;
			feature_key: string;
			event_type: UsageAlertEvent["eventType"];
			current_value: unknown;
			threshold_value: unknown;
			window_start_at: Date | string;
			created_at: Date | string;
		}>(
			this.database,
			drizzleSql`
			SELECT event.id, event.alert_id, entity.external_id AS entity_external_id,
				feature.key AS feature_key, event.event_type, event.current_value::text AS current_value,
				event.threshold_value::text AS threshold_value, event.window_start_at, event.created_at
			FROM usage_alert_events event
			JOIN features feature ON feature.project_id = event.project_id AND feature.id = event.feature_id
			LEFT JOIN entities entity ON entity.project_id = event.project_id AND entity.id = event.entity_id
			WHERE event.project_id = ${projectId} AND event.customer_id = ${customer.id}
			ORDER BY event.created_at DESC, event.id DESC LIMIT ${limit}
		`,
		);
		return rows.map((row) => ({
			id: String(row.id),
			alertId: String(row.alert_id),
			entityId: row.entity_external_id,
			featureKey: row.feature_key,
			eventType: row.event_type,
			currentValue: String(row.current_value),
			thresholdValue: String(row.threshold_value),
			windowStartAt: toIso(row.window_start_at),
			createdAt: toIso(row.created_at),
		}));
	}

	async upsertAutoTopupPolicy(
		project: ProjectInstanceContext,
		input: AutoTopupPolicyInput,
	): Promise<AutoTopupPolicyRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
			const entity = await resolveEntity(tx, projectId, customer.id, input.entityId ?? null);
			const feature = await requireFeature(tx, projectId, input.featureKey);
			const threshold = canonicalDecimal(
				input.thresholdQuantity,
				"thresholdQuantity",
				feature.credit_scale,
			);
			const option = await executeOne<{
				id: string | number | bigint;
				amount_minor: string | number | bigint | null;
			}>(
				tx,
				drizzleSql`
				SELECT option.id, store.price_amount AS amount_minor
				FROM topup_options option
				JOIN catalog_revisions revision ON revision.project_id = option.project_id
					AND revision.id = option.catalog_revision_id AND revision.status = 'published'
				JOIN features option_feature ON option_feature.project_id = option.project_id
					AND option_feature.id = option.feature_id
				JOIN provider_topup_bindings binding ON binding.project_id = option.project_id
					AND binding.topup_option_id = option.id AND binding.provider = ${input.provider}
					AND binding.status = 'published'
				JOIN store_products store ON store.project_id = binding.project_id
					AND store.id = binding.store_product_id
				WHERE option.project_id = ${projectId} AND option.key = ${requiredText(input.topupKey, "topupKey", 120)}
					AND option_feature.id = ${feature.id}::bigint
				LIMIT 1
			`,
			);
			if (option === null)
				throw new InvalidRequestError(
					"Top-up option is not published for this provider and feature",
				);
			const existing = await executeOne<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
				SELECT id FROM auto_topup_policies
				WHERE project_id = ${projectId} AND customer_id = ${customer.id}
					AND feature_id = ${feature.id}::bigint
					AND entity_id IS NOT DISTINCT FROM ${entity?.id ?? null}::bigint
				FOR UPDATE
			`,
			);
			const values = {
				cooldown: boundedInteger(input.cooldownSeconds ?? 30, "cooldownSeconds", 30, 86400),
				interval: boundedInteger(
					input.limitIntervalSeconds ?? 86400,
					"limitIntervalSeconds",
					60,
					31_536_000,
				),
				purchases: boundedInteger(
					input.maxPurchasesPerInterval ?? 3,
					"maxPurchasesPerInterval",
					1,
					1000,
				),
				failures: boundedInteger(
					input.maxConsecutiveFailures ?? 3,
					"maxConsecutiveFailures",
					1,
					100,
				),
			};
			const optionAmount = option.amount_minor === null ? null : Number(option.amount_minor);
			if (
				input.provider === "stripe" &&
				(optionAmount === null || !Number.isSafeInteger(optionAmount) || optionAmount <= 0)
			) {
				throw new InvalidRequestError("Stripe auto top-up requires a positive published price");
			}
			const maxSpendMinor =
				input.provider === "stripe" && optionAmount !== null
					? (input.maxSpendMinor ?? optionAmount * values.purchases)
					: (input.maxSpendMinor ?? null);
			if (maxSpendMinor !== null && (!Number.isSafeInteger(maxSpendMinor) || maxSpendMinor <= 0)) {
				throw new InvalidRequestError("maxSpendMinor must be a positive safe integer");
			}
			if (optionAmount !== null && maxSpendMinor !== null && maxSpendMinor < optionAmount) {
				throw new InvalidRequestError("maxSpendMinor must cover at least one auto top-up");
			}
			const row =
				existing === null
					? await executeOne<{ id: string | number | bigint }>(
							tx,
							drizzleSql`
					INSERT INTO auto_topup_policies (
						project_id, customer_id, entity_id, feature_id, topup_option_id, provider,
						threshold_quantity, cooldown_seconds, limit_interval_seconds,
						max_purchases_per_interval, max_spend_minor, max_consecutive_failures, created_by
					) VALUES (
						${projectId}, ${customer.id}, ${entity?.id ?? null}::bigint, ${feature.id}::bigint,
						${String(option.id)}::bigint, ${input.provider}, ${threshold}::numeric,
						${values.cooldown}, ${values.interval}, ${values.purchases}, ${maxSpendMinor},
						${values.failures}, ${requiredText(input.actor, "actor", 200)}
					) RETURNING id
				`,
						)
					: await executeOne<{ id: string | number | bigint }>(
							tx,
							drizzleSql`
					UPDATE auto_topup_policies SET topup_option_id = ${String(option.id)}::bigint,
						provider = ${input.provider}, threshold_quantity = ${threshold}::numeric,
						cooldown_seconds = ${values.cooldown}, limit_interval_seconds = ${values.interval},
						max_purchases_per_interval = ${values.purchases}, max_spend_minor = ${maxSpendMinor},
						max_consecutive_failures = ${values.failures}, active = true, updated_at = now()
					WHERE project_id = ${projectId} AND id = ${String(existing.id)}::bigint RETURNING id
				`,
						);
			if (row === null) throw new Error("Auto top-up policy could not be persisted");
			await executeOne(
				tx,
				drizzleSql`
				INSERT INTO auto_topup_states (project_id, policy_id) VALUES (${projectId}, ${String(row.id)}::bigint)
				ON CONFLICT (project_id, policy_id) DO NOTHING RETURNING policy_id
			`,
			);
			return await requireAutoTopupPolicy(tx, projectId, customer.id, String(row.id));
		});
	}

	async getAutoTopupPolicy(
		project: ProjectInstanceContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	): Promise<AutoTopupPolicyRecord | null> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, billingAccountId);
		const entity = await resolveEntity(this.database, projectId, customer.id, entityId ?? null);
		const row = await executeOne<{ id: string | number | bigint }>(
			this.database,
			drizzleSql`
			SELECT policy.id FROM auto_topup_policies policy
			JOIN features feature ON feature.project_id = policy.project_id AND feature.id = policy.feature_id
			WHERE policy.project_id = ${projectId} AND policy.customer_id = ${customer.id}
				AND feature.key = ${requiredText(featureKey, "featureKey", 120)}
				AND policy.entity_id IS NOT DISTINCT FROM ${entity?.id ?? null}::bigint LIMIT 1
		`,
		);
		return row === null
			? null
			: await requireAutoTopupPolicy(this.database, projectId, customer.id, String(row.id));
	}

	async resetAutoTopupCircuit(
		project: ProjectInstanceContext,
		billingAccountId: string,
		policyId: string,
		actor: string,
	): Promise<AutoTopupPolicyRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, billingAccountId);
			const row = await executeOne(
				tx,
				drizzleSql`
				UPDATE auto_topup_states state SET status = 'ready', consecutive_failures = 0,
					cooldown_until = NULL, circuit_opened_at = NULL, last_error = NULL, updated_at = now()
				FROM auto_topup_policies policy
				WHERE state.project_id = ${projectId} AND state.policy_id = ${policyId}::bigint
					AND policy.project_id = state.project_id AND policy.id = state.policy_id
					AND policy.customer_id = ${customer.id} RETURNING state.policy_id
			`,
			);
			if (row === null)
				throw new NotFoundBillingError(
					"Auto top-up policy was not found",
					"AUTO_TOPUP_POLICY_NOT_FOUND",
				);
			await insertAudit(tx, projectId, "auto_topup_reset", actor, { policyId, billingAccountId });
			return await requireAutoTopupPolicy(tx, projectId, customer.id, policyId);
		});
	}

	async previewEnterpriseContract(
		project: ProjectInstanceContext,
		input: EnterpriseContractInput,
	): Promise<EnterpriseContractPreview> {
		return await this.transaction(async (tx) => {
			const context = await contractContext(tx, project, input);
			const intentHash = sha256Hex(stableJson(context.intent));
			const previewToken = sha256Hex(stableJson({ intentHash, nonce: crypto.randomUUID() }));
			const previewExpiresAt = new Date(Date.now() + 30 * 60_000);
			const existing = await executeOne<{
				id: string | number | bigint;
				status: string;
				intent_hash: string;
				preview_token: string;
				terms: { previewExpiresAt?: string };
			}>(
				tx,
				drizzleSql`
					SELECT id, status, intent_hash, preview_token, terms
					FROM enterprise_contracts
					WHERE project_id = ${context.projectId} AND customer_id = ${context.customerId}
						AND contract_key = ${context.intent.contractKey}
						AND version = ${context.intent.version}
					FOR UPDATE
				`,
			);
			if (existing?.status !== undefined && existing.status !== "draft") {
				throw new PersistenceConflictError(
					"Enterprise contract version already exists",
					"ENTERPRISE_CONTRACT_VERSION_EXISTS",
				);
			}
			const existingExpiry = existing?.terms.previewExpiresAt;
			if (
				existing !== null &&
				existing.intent_hash === intentHash &&
				typeof existingExpiry === "string" &&
				new Date(existingExpiry) > new Date()
			) {
				return {
					previewToken: existing.preview_token,
					billingAccountId: context.intent.billingAccountId,
					contractKey: context.intent.contractKey,
					version: context.intent.version,
					planVersionId: context.planVersionId,
					expiresAt: existingExpiry,
					controls: context.intent.controls.length,
				};
			}
			const previewTerms = jsonb({
				terms: context.intent.terms,
				controls: context.intent.controls,
				previewExpiresAt: previewExpiresAt.toISOString(),
			});
			const row =
				existing === null
					? await executeOne<{ id: string | number | bigint }>(
							tx,
							drizzleSql`
						INSERT INTO enterprise_contracts (
							project_id, customer_id, contract_key, version, status, plan_version_id,
							replaces_commercial_defaults, effective_at, expires_at, terms,
							preview_token, intent_hash, created_by
						) VALUES (
							${context.projectId}, ${context.customerId}, ${context.intent.contractKey},
							${context.intent.version}, 'draft', ${context.planVersionId}::bigint,
							${context.intent.replacesCommercialDefaults}, ${context.intent.effectiveAt},
							${context.intent.expiresAt}, ${previewTerms},
							${previewToken}, ${intentHash}, ${context.intent.actor}
						) RETURNING id
					`,
						)
					: await executeOne<{ id: string | number | bigint }>(
							tx,
							drizzleSql`
						UPDATE enterprise_contracts
						SET plan_version_id = ${context.planVersionId}::bigint,
							replaces_commercial_defaults = ${context.intent.replacesCommercialDefaults},
							effective_at = ${context.intent.effectiveAt}, expires_at = ${context.intent.expiresAt},
							terms = ${previewTerms}, preview_token = ${previewToken},
							intent_hash = ${intentHash}, created_by = ${context.intent.actor}, updated_at = now()
						WHERE project_id = ${context.projectId} AND id = ${String(existing.id)}::bigint
							AND status = 'draft'
						RETURNING id
					`,
						);
			if (row === null) throw new Error("Contract preview could not be persisted");
			return {
				previewToken,
				billingAccountId: context.intent.billingAccountId,
				contractKey: context.intent.contractKey,
				version: context.intent.version,
				planVersionId: context.planVersionId,
				expiresAt: previewExpiresAt.toISOString(),
				controls: context.intent.controls.length,
			};
		});
	}

	async publishEnterpriseContract(
		project: ProjectInstanceContext,
		input: EnterpriseContractInput & { previewToken: string },
	): Promise<EnterpriseContractRecord> {
		return await this.transaction(async (tx) => {
			const context = await contractContext(tx, project, input);
			const row = await executeOne<{
				id: string | number | bigint;
				status: string;
				intent_hash: string;
				terms: { previewExpiresAt?: string };
			}>(
				tx,
				drizzleSql`
				SELECT id, status, intent_hash, terms FROM enterprise_contracts
				WHERE project_id = ${context.projectId} AND preview_token = ${input.previewToken} FOR UPDATE
			`,
			);
			if (row === null)
				throw new PersistenceConflictError(
					"Contract preview was not found",
					"CONTRACT_PREVIEW_NOT_FOUND",
				);
			if (row.status === "published")
				return await requireContract(tx, context.projectId, String(row.id));
			if (
				row.status !== "draft" ||
				typeof row.terms.previewExpiresAt !== "string" ||
				new Date(row.terms.previewExpiresAt) <= new Date()
			) {
				throw new PersistenceConflictError(
					"Contract preview has expired",
					"CONTRACT_PREVIEW_EXPIRED",
				);
			}
			if (row.intent_hash !== sha256Hex(stableJson(context.intent))) {
				throw new PersistenceConflictError(
					"Contract intent differs from preview",
					"CONTRACT_PREVIEW_MISMATCH",
				);
			}
			await executeOne(
				tx,
				drizzleSql`
					SELECT id FROM customers
					WHERE project_id = ${context.projectId} AND id = ${context.customerId}
					FOR UPDATE
				`,
			);
			await executeOne(
				tx,
				drizzleSql`
				UPDATE enterprise_contracts SET status = 'published', published_at = now(), updated_at = now()
				WHERE project_id = ${context.projectId} AND id = ${String(row.id)}::bigint RETURNING id
			`,
			);
			for (const control of context.intent.controls) {
				const normalized = await normalizeControlInput(tx, context.projectId, control);
				await executeOne(
					tx,
					drizzleSql`
					INSERT INTO control_policies (
						project_id, source_type, contract_id, control_kind, feature_id, currency,
						limit_value, interval, revision, effective_at, expires_at, created_by
					) VALUES (
						${context.projectId}, 'contract', ${String(row.id)}::bigint, ${normalized.controlKind},
						${normalized.featureId}::bigint, ${normalized.currency}, ${normalized.limitValue}::numeric,
						${normalized.interval}, ${context.intent.version}, ${context.intent.effectiveAt},
						${context.intent.expiresAt}, ${context.intent.actor}
					) RETURNING id
				`,
				);
			}
			await insertAudit(tx, context.projectId, "contract_published", input.actor, {
				contractId: String(row.id),
				billingAccountId: input.billingAccountId,
			});
			return await requireContract(tx, context.projectId, String(row.id));
		});
	}

	async listEnterpriseContracts(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<EnterpriseContractRecord[]> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, billingAccountId);
		const rows = await executeRows<{ id: string | number | bigint }>(
			this.database,
			drizzleSql`
				SELECT id FROM enterprise_contracts
				WHERE project_id = ${projectId} AND customer_id = ${customer.id}
					AND status <> 'draft'
				ORDER BY effective_at DESC, version DESC, id DESC
			`,
		);
		const contracts: EnterpriseContractRecord[] = [];
		for (const row of rows) {
			contracts.push(await requireContract(this.database, projectId, String(row.id)));
		}
		return contracts;
	}

	async terminateEnterpriseContract(
		project: ProjectInstanceContext,
		billingAccountId: string,
		contractId: string,
		actor: string,
	): Promise<EnterpriseContractRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, billingAccountId);
			const row = await executeOne<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
					UPDATE enterprise_contracts
					SET status = 'terminated', updated_at = now()
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
						AND id = ${contractId}::bigint AND status = 'published'
					RETURNING id
				`,
			);
			if (row === null) {
				throw new NotFoundBillingError(
					"Published enterprise contract was not found",
					"ENTERPRISE_CONTRACT_NOT_FOUND",
				);
			}
			await insertAudit(tx, projectId, "contract_terminated", actor, {
				contractId,
				billingAccountId,
			});
			return await requireContract(tx, projectId, contractId);
		});
	}

	async previewCatalogMigration(
		project: ProjectInstanceContext,
		input: CatalogMigrationInput,
	): Promise<CatalogMigrationPreview> {
		return await this.transaction(async (tx) => {
			const context = await migrationContext(tx, project, input);
			const previewToken = sha256Hex(stableJson({ ...context.intent, nonce: crypto.randomUUID() }));
			const intentHash = sha256Hex(stableJson(context.intent));
			const expiresAt = new Date(Date.now() + 30 * 60_000);
			await executeOne(
				tx,
				drizzleSql`
				INSERT INTO catalog_migration_drafts (
					project_id, from_plan_version_id, to_plan_version_id, preview_token,
					intent_hash, effective_mode, impact, created_by, expires_at
				) VALUES (
					${context.projectId}, ${context.fromPlanVersionId}::bigint, ${context.toPlanVersionId}::bigint,
					${previewToken}, ${intentHash}, ${input.effectiveMode},
					${jsonb({ matchingSubscriptions: context.matchingSubscriptions })}, ${context.intent.actor},
					${expiresAt.toISOString()}
				) RETURNING id
			`,
			);
			return {
				previewToken,
				fromPlanVersionId: context.fromPlanVersionId,
				toPlanVersionId: context.toPlanVersionId,
				matchingSubscriptions: context.matchingSubscriptions,
				expiresAt: expiresAt.toISOString(),
			};
		});
	}

	async publishCatalogMigration(
		project: ProjectInstanceContext,
		input: CatalogMigrationInput & { previewToken: string },
	): Promise<CatalogMigrationResult> {
		return await this.transaction(async (tx) => {
			const context = await migrationContext(tx, project, input);
			const draft = await executeOne<{
				id: string;
				status: "previewed" | "published" | "expired";
				intent_hash: string;
				expires_at: Date | string;
				impact: { matchingSubscriptions?: number };
			}>(
				tx,
				drizzleSql`
				SELECT id, status, intent_hash, expires_at, impact FROM catalog_migration_drafts
				WHERE project_id = ${context.projectId} AND preview_token = ${input.previewToken} FOR UPDATE
			`,
			);
			if (draft === null)
				throw new PersistenceConflictError(
					"Migration preview was not found",
					"MIGRATION_PREVIEW_NOT_FOUND",
				);
			const base = {
				previewToken: input.previewToken,
				fromPlanVersionId: context.fromPlanVersionId,
				toPlanVersionId: context.toPlanVersionId,
				matchingSubscriptions: Number(
					draft.impact.matchingSubscriptions ?? context.matchingSubscriptions,
				),
				expiresAt: toIso(draft.expires_at),
			};
			if (draft.status === "published") {
				const count = await executeOne<{ count: string }>(
					tx,
					drizzleSql`SELECT count(*)::text AS count FROM catalog_migration_jobs WHERE project_id = ${context.projectId} AND draft_id = ${draft.id}`,
				);
				return { ...base, queued: Number(count?.count ?? 0), duplicate: true };
			}
			if (draft.status !== "previewed" || new Date(draft.expires_at) <= new Date())
				throw new PersistenceConflictError(
					"Migration preview has expired",
					"MIGRATION_PREVIEW_EXPIRED",
				);
			if (draft.intent_hash !== sha256Hex(stableJson(context.intent)))
				throw new PersistenceConflictError(
					"Migration intent differs from preview",
					"MIGRATION_PREVIEW_MISMATCH",
				);
			const inserted = await executeRows(
				tx,
				drizzleSql`
				INSERT INTO catalog_migration_jobs (project_id, draft_id, subscription_id, effective_mode)
				SELECT ${context.projectId}, ${draft.id}, subscription.id, ${input.effectiveMode}
				FROM subscriptions subscription
				WHERE subscription.project_id = ${context.projectId}
					AND subscription.plan_version_id = ${context.fromPlanVersionId}::bigint
					AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (subscription.status <> 'cancelled'
						OR COALESCE(subscription.expires_at, subscription.current_period_end) > now())
					AND (${context.targetCustomerId}::uuid IS NULL
						OR subscription.customer_id = ${context.targetCustomerId}::uuid)
				ON CONFLICT (project_id, draft_id, subscription_id) DO NOTHING RETURNING id
			`,
			);
			await executeOne(
				tx,
				drizzleSql`UPDATE catalog_migration_drafts SET status = 'published', published_at = now(), updated_at = now() WHERE project_id = ${context.projectId} AND id = ${draft.id} RETURNING id`,
			);
			await insertAudit(tx, context.projectId, "plan_migrated", input.actor, {
				draftId: draft.id,
				queued: inserted.length,
				fromPlanVersionId: context.fromPlanVersionId,
				toPlanVersionId: context.toPlanVersionId,
			});
			return { ...base, queued: inserted.length, duplicate: false };
		});
	}

	async listLicensePools(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<LicensePoolRecord[]> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, billingAccountId);
			await executeOne(
				tx,
				drizzleSql`
					SELECT id FROM customers
					WHERE project_id = ${projectId} AND id = ${customer.id}
					FOR UPDATE
				`,
			);
			await executeRows(
				tx,
				drizzleSql`
					UPDATE license_pools SET active = false, updated_at = now()
					WHERE project_id = ${projectId} AND customer_id = ${customer.id} AND active = true
				`,
			);
			await executeRows(
				tx,
				drizzleSql`
				INSERT INTO license_pools (project_id, customer_id, subscription_id, plan_item_id, feature_id, quantity)
				SELECT subscription.project_id, subscription.customer_id, subscription.id, item.id, item.feature_id,
					COALESCE(subscription_item.quantity, item.quantity::integer)
				FROM subscriptions subscription
				JOIN plan_items item
					ON item.project_id = subscription.project_id
					AND item.plan_version_id = subscription.plan_version_id
				JOIN price_components price
					ON price.project_id = item.project_id AND price.plan_item_id = item.id
					AND price.component_kind = 'licensed'
				LEFT JOIN subscription_items subscription_item
					ON subscription_item.project_id = subscription.project_id
					AND subscription_item.subscription_id = subscription.id
					AND subscription_item.price_component_id = price.id
					AND subscription_item.active = true
				WHERE subscription.project_id = ${projectId} AND subscription.customer_id = ${customer.id}
					AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
					AND item.item_kind = 'licensed_quantity' AND item.allocation_scope = 'license_pool'
				ON CONFLICT (project_id, subscription_id, plan_item_id) DO UPDATE SET
					quantity = EXCLUDED.quantity, active = true, updated_at = now()
			`,
			);
			const rows = await executeRows<{
				id: string | number | bigint;
				external_subscription_id: string;
				feature_key: string;
				quantity: number;
				assigned_quantity: number;
				active: boolean;
			}>(
				tx,
				drizzleSql`
				SELECT pool.id, subscription.external_subscription_id, feature.key AS feature_key,
					pool.quantity, COALESCE(sum(assignment.quantity) FILTER (WHERE assignment.revoked_at IS NULL), 0)::integer AS assigned_quantity,
					pool.active
				FROM license_pools pool
				JOIN subscriptions subscription ON subscription.project_id = pool.project_id AND subscription.id = pool.subscription_id
				JOIN features feature ON feature.project_id = pool.project_id AND feature.id = pool.feature_id
				LEFT JOIN license_assignments assignment ON assignment.project_id = pool.project_id AND assignment.license_pool_id = pool.id
				WHERE pool.project_id = ${projectId} AND pool.customer_id = ${customer.id}
				GROUP BY pool.id, subscription.external_subscription_id, feature.key ORDER BY pool.created_at, pool.id
			`,
			);
			return rows.map((row) => ({
				id: String(row.id),
				externalSubscriptionId: row.external_subscription_id,
				featureKey: row.feature_key,
				quantity: row.quantity,
				assignedQuantity: row.assigned_quantity,
				availableQuantity: Math.max(0, row.quantity - row.assigned_quantity),
				active: row.active,
			}));
		});
	}

	async assignLicense(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			poolId: string;
			entityId: string;
			quantity: number;
			actor: string;
		},
	): Promise<LicenseAssignmentRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
			const entity = await resolveEntity(tx, projectId, customer.id, input.entityId);
			if (entity === null)
				throw new NotFoundBillingError("Entity was not found", "ENTITY_NOT_FOUND");
			const quantity = boundedInteger(input.quantity, "quantity", 1, 1_000_000);
			const pool = await executeOne<{ quantity: number }>(
				tx,
				drizzleSql`SELECT quantity FROM license_pools WHERE project_id = ${projectId} AND id = ${input.poolId}::bigint AND customer_id = ${customer.id} AND active = true FOR UPDATE`,
			);
			if (pool === null)
				throw new NotFoundBillingError("License pool was not found", "LICENSE_POOL_NOT_FOUND");
			const existing = await executeOne<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
				SELECT id FROM license_assignments
				WHERE project_id = ${projectId} AND license_pool_id = ${input.poolId}::bigint
					AND entity_id = ${entity.id}::bigint AND revoked_at IS NULL
				FOR UPDATE
			`,
			);
			if (existing !== null) {
				throw new PersistenceConflictError(
					"Entity already has an active assignment from this license pool",
					"LICENSE_ALREADY_ASSIGNED",
				);
			}
			const assigned = await executeOne<{ quantity: number }>(
				tx,
				drizzleSql`SELECT COALESCE(sum(quantity), 0)::integer AS quantity FROM license_assignments WHERE project_id = ${projectId} AND license_pool_id = ${input.poolId}::bigint AND revoked_at IS NULL`,
			);
			if ((assigned?.quantity ?? 0) + quantity > pool.quantity)
				throw new PersistenceConflictError(
					"License pool does not have enough available quantity",
					"LICENSE_POOL_EXHAUSTED",
				);
			const row = await executeOne<AssignmentDbRow>(
				tx,
				drizzleSql`
				INSERT INTO license_assignments (project_id, license_pool_id, entity_id, quantity, assigned_by)
				VALUES (${projectId}, ${input.poolId}::bigint, ${entity.id}::bigint, ${quantity}, ${requiredText(input.actor, "actor", 200)})
				RETURNING id, license_pool_id, entity_id, quantity, assigned_at, revoked_at
			`,
			);
			if (row === null) throw new Error("License assignment could not be persisted");
			await insertAudit(tx, projectId, "license_changed", input.actor, {
				action: "assigned",
				assignmentId: String(row.id),
				poolId: input.poolId,
				entityId: input.entityId,
				quantity,
			});
			return assignmentRecord(row, input.entityId);
		});
	}

	async revokeLicense(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; assignmentId: string; actor: string },
	): Promise<LicenseAssignmentRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
			const row = await executeOne<AssignmentDbRow & { entity_external_id: string }>(
				tx,
				drizzleSql`
				UPDATE license_assignments assignment SET revoked_at = COALESCE(revoked_at, now())
				FROM license_pools pool, entities entity
				WHERE assignment.project_id = ${projectId} AND assignment.id = ${input.assignmentId}::bigint
					AND pool.project_id = assignment.project_id AND pool.id = assignment.license_pool_id
					AND pool.customer_id = ${customer.id}
					AND entity.project_id = assignment.project_id AND entity.id = assignment.entity_id
				RETURNING assignment.id, assignment.license_pool_id, assignment.entity_id, assignment.quantity,
					assignment.assigned_at, assignment.revoked_at, entity.external_id AS entity_external_id
			`,
			);
			if (row === null)
				throw new NotFoundBillingError(
					"License assignment was not found",
					"LICENSE_ASSIGNMENT_NOT_FOUND",
				);
			await insertAudit(tx, projectId, "license_changed", input.actor, {
				action: "revoked",
				assignmentId: input.assignmentId,
			});
			return assignmentRecord(row, row.entity_external_id);
		});
	}

	async checkEntityLicense(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			entityId: string;
			featureKey: string;
			requiredQuantity: number;
		},
	): Promise<EntityLicenseDecision> {
		const requiredQuantity = boundedInteger(
			input.requiredQuantity,
			"requiredQuantity",
			1,
			1_000_000,
		);
		await this.listLicensePools(project, input.billingAccountId);
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, input.billingAccountId);
		const entity = await resolveEntity(this.database, projectId, customer.id, input.entityId);
		if (entity === null) throw new NotFoundBillingError("Entity was not found", "ENTITY_NOT_FOUND");
		const feature = await requireFeature(this.database, projectId, input.featureKey);
		const row = await executeOne<{ assigned_quantity: number }>(
			this.database,
			drizzleSql`
				SELECT COALESCE(sum(assignment.quantity), 0)::integer AS assigned_quantity
				FROM license_assignments assignment
				JOIN license_pools pool
					ON pool.project_id = assignment.project_id AND pool.id = assignment.license_pool_id
				JOIN subscriptions subscription
					ON subscription.project_id = pool.project_id AND subscription.id = pool.subscription_id
				WHERE assignment.project_id = ${projectId} AND assignment.entity_id = ${entity.id}::bigint
					AND assignment.revoked_at IS NULL AND pool.active = true
					AND pool.customer_id = ${customer.id} AND pool.feature_id = ${String(feature.id)}::bigint
					AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
			`,
		);
		const assignedQuantity = row?.assigned_quantity ?? 0;
		return {
			entityId: input.entityId,
			featureKey: feature.key,
			requiredQuantity,
			assignedQuantity,
			allowed: assignedQuantity >= requiredQuantity,
		};
	}
}

export async function resolveEffectiveControls(
	executor: QueryExecutor,
	input: { projectId: string; customerId: string; entityId: string | null; now?: Date },
): Promise<EffectiveControl[]> {
	let now = input.now;
	if (now === undefined) {
		const clock = await executeOne<{ current_time: Date | string }>(
			executor,
			drizzleSql`SELECT CURRENT_TIMESTAMP AS current_time`,
		);
		if (clock === null) throw new Error("Database clock could not be read");
		now = clock.current_time instanceof Date ? clock.current_time : new Date(clock.current_time);
	}
	// One statement: the active contract is resolved inline so this read can be pipelined.
	const rows = await executeRows<EffectiveControlRow>(
		executor,
		drizzleSql`
		WITH active_contract AS (
			SELECT id, replaces_commercial_defaults FROM enterprise_contracts
			WHERE project_id = ${input.projectId} AND customer_id = ${input.customerId}
				AND status = 'published' AND effective_at <= ${now.toISOString()}
				AND (expires_at IS NULL OR expires_at > ${now.toISOString()})
			ORDER BY effective_at DESC, version DESC, id DESC LIMIT 1
		)
		SELECT DISTINCT policy.id, policy.source_type, policy.control_kind, feature.key AS feature_key,
			policy.currency, policy.limit_value::text AS limit_value, policy.interval, policy.revision,
			(SELECT replaces_commercial_defaults FROM active_contract) AS contract_replaces_defaults
		FROM control_policies policy
		LEFT JOIN features feature ON feature.project_id = policy.project_id AND feature.id = policy.feature_id
		WHERE policy.project_id = ${input.projectId} AND policy.active = true
			AND policy.effective_at <= ${now.toISOString()}
			AND (policy.expires_at IS NULL OR policy.expires_at > ${now.toISOString()})
			AND (
				(policy.source_type = 'plan_default' AND EXISTS (
					SELECT 1 FROM subscriptions subscription
					WHERE subscription.project_id = policy.project_id
						AND subscription.customer_id = ${input.customerId}
						AND subscription.plan_version_id = policy.plan_version_id
						AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
						AND (subscription.expires_at IS NULL OR subscription.expires_at > ${now.toISOString()})
						AND (subscription.entity_id IS NULL OR subscription.entity_id = ${input.entityId}::bigint)
				))
				OR (policy.source_type = 'contract' AND policy.contract_id = (SELECT id FROM active_contract))
				OR (policy.source_type = 'account' AND policy.customer_id = ${input.customerId})
				OR (policy.source_type = 'entity' AND policy.customer_id = ${input.customerId}
					AND policy.entity_id = ${input.entityId}::bigint)
			)
	`,
	);
	const controlIdentity = (row: EffectiveControlRow) =>
		[row.control_kind, row.feature_key ?? "", row.currency ?? "", row.interval].join(":");
	const replacedPlanDefaults = new Set(
		rows[0]?.contract_replaces_defaults === true
			? rows.filter((row) => row.source_type === "contract").map((row) => controlIdentity(row))
			: [],
	);
	const eligible = rows.filter(
		(row) => row.source_type !== "plan_default" || !replacedPlanDefaults.has(controlIdentity(row)),
	);
	const winners = new Map<string, EffectiveControlRow>();
	for (const row of eligible) {
		const identity = controlIdentity(row);
		const current = winners.get(identity);
		if (current === undefined || compareControlRows(row, current) < 0) winners.set(identity, row);
	}
	const result: EffectiveControl[] = [];
	const winnerRows = [...winners.values()];
	const windows = await Promise.all(
		winnerRows.map((row) => {
			const bounds = controlWindowBounds(row.interval, now);
			return executeOne<{ consumed_value: unknown; held_value: unknown }>(
				executor,
				drizzleSql`
			SELECT consumed_value::text AS consumed_value, held_value::text AS held_value
			FROM control_windows WHERE project_id = ${input.projectId}
				AND control_policy_id = ${String(row.id)}::bigint AND customer_id = ${input.customerId}
				AND window_start_at = ${bounds.start.toISOString()} LIMIT 1
		`,
			);
		}),
	);
	for (const [index, row] of winnerRows.entries()) {
		const window = windows[index] ?? null;
		const limit = canonicalDecimal(String(row.limit_value), "control limit", 9);
		const consumed = canonicalDecimal(String(window?.consumed_value ?? "0"), "control consumed", 9);
		const held = canonicalDecimal(String(window?.held_value ?? "0"), "control held", 9);
		const remaining =
			decimalToUnits(limit, 9) - decimalToUnits(consumed, 9) - decimalToUnits(held, 9);
		result.push({
			controlKind: row.control_kind,
			featureKey: row.feature_key,
			currency: row.currency,
			limitValue: limit,
			interval: row.interval,
			source: row.source_type,
			revision: row.revision,
			policyId: String(row.id),
			consumedValue: consumed,
			heldValue: held,
			remainingValue: unitsToDecimal(remaining > 0n ? remaining : 0n, 9),
		});
	}
	return result.sort((left, right) =>
		[left.controlKind, left.featureKey ?? "", left.currency ?? ""]
			.join(":")
			.localeCompare([right.controlKind, right.featureKey ?? "", right.currency ?? ""].join(":")),
	);
}

export function controlWindowBounds(
	interval: ControlInterval,
	now: Date,
): { start: Date; end: Date | null } {
	if (interval === "lifetime") return { start: new Date(0), end: null };
	const start =
		interval === "month"
			? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
			: new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
	const end = new Date(start);
	if (interval === "month") end.setUTCMonth(end.getUTCMonth() + 1);
	else end.setUTCFullYear(end.getUTCFullYear() + 1);
	return { start, end };
}

function compareControlRows(left: EffectiveControlRow, right: EffectiveControlRow): number {
	const amount =
		decimalToUnits(String(left.limit_value), 9) - decimalToUnits(String(right.limit_value), 9);
	if (amount !== 0n) return amount < 0n ? -1 : 1;
	const rank = { plan_default: 1, contract: 2, account: 3, entity: 4 };
	return rank[right.source_type] - rank[left.source_type];
}

async function normalizeControlInput(
	executor: QueryExecutor,
	projectId: string,
	input: Pick<
		ControlPolicyInput,
		"controlKind" | "featureKey" | "currency" | "limitValue" | "interval"
	>,
) {
	const limitValue = canonicalDecimal(input.limitValue, "limitValue", 9);
	if (input.controlKind === "spend_limit") {
		const currency = input.currency?.trim().toUpperCase() ?? null;
		if (
			currency === null ||
			!/^[A-Z]{3}$/.test(currency) ||
			input.featureKey != null ||
			limitValue.includes(".")
		) {
			throw new InvalidRequestError(
				"Spend limits require integer minor units, a three-letter currency, and no feature",
			);
		}
		return {
			controlKind: input.controlKind,
			featureId: null,
			featureKey: null,
			currency,
			limitValue,
			interval: input.interval,
		};
	}
	if (input.currency != null || input.featureKey == null)
		throw new InvalidRequestError("Usage limits require a feature and no currency");
	const feature = await requireFeature(executor, projectId, input.featureKey);
	return {
		controlKind: input.controlKind,
		featureId: String(feature.id),
		featureKey: feature.key,
		currency: null,
		limitValue: canonicalDecimal(input.limitValue, "limitValue", feature.credit_scale),
		interval: input.interval,
	};
}

interface EntityDbRow {
	id: string | number | bigint;
	external_id: string;
	kind: string;
	metadata: Record<string, unknown>;
	created_at: Date | string;
	updated_at: Date | string;
}
interface AlertDbRow {
	id: string | number | bigint;
	entity_id: string | number | bigint | null;
	threshold_type: "absolute" | "percentage";
	threshold_value: unknown;
	interval: ControlInterval;
	active: boolean;
	created_at: Date | string;
}
interface AssignmentDbRow {
	id: string | number | bigint;
	license_pool_id: string | number | bigint;
	entity_id: string | number | bigint;
	quantity: number;
	assigned_at: Date | string;
	revoked_at: Date | string | null;
}

async function requireCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<{ id: string }> {
	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`SELECT id FROM customers WHERE project_id = ${projectId} AND billing_account_id = ${requiredText(billingAccountId, "billingAccountId", 200)} LIMIT 1`,
	);
	if (row === null)
		throw new NotFoundBillingError("Billing account was not found", "BILLING_ACCOUNT_NOT_FOUND");
	return row;
}

async function resolveEntity(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	externalId: string | null,
): Promise<{ id: string; external_id: string } | null> {
	if (externalId === null) return null;
	const row = await executeOne<{ id: string; external_id: string }>(
		executor,
		drizzleSql`SELECT id, external_id FROM entities WHERE project_id = ${projectId} AND customer_id = ${customerId} AND external_id = ${requiredText(externalId, "entityId", 200)} LIMIT 1`,
	);
	if (row === null) throw new NotFoundBillingError("Entity was not found", "ENTITY_NOT_FOUND");
	return row;
}

async function requireFeature(
	executor: QueryExecutor,
	projectId: string,
	key: string,
): Promise<{ id: string | number | bigint; key: string; credit_scale: number }> {
	const row = await executeOne<{ id: string | number | bigint; key: string; credit_scale: number }>(
		executor,
		drizzleSql`SELECT id, key, credit_scale FROM features WHERE project_id = ${projectId} AND key = ${requiredText(key, "featureKey", 120)} AND kind = 'metered' AND active = true LIMIT 1`,
	);
	if (row === null)
		throw new NotFoundBillingError("Metered feature was not found", "FEATURE_NOT_FOUND");
	return row;
}

function entityRecord(row: EntityDbRow): EntityRecord {
	return {
		id: String(row.id),
		externalId: row.external_id,
		kind: row.kind,
		metadata: row.metadata,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}
function alertRecord(
	row: AlertDbRow,
	featureKey: string,
	entityId: string | null,
	currentValue: string,
	crossed: boolean,
): UsageAlertRecord {
	return {
		id: String(row.id),
		entityId,
		featureKey,
		thresholdType: row.threshold_type,
		thresholdValue: String(row.threshold_value),
		interval: row.interval,
		active: row.active,
		currentValue,
		crossed,
		createdAt: toIso(row.created_at),
	};
}
function assignmentRecord(row: AssignmentDbRow, entityId: string): LicenseAssignmentRecord {
	return {
		id: String(row.id),
		poolId: String(row.license_pool_id),
		entityId,
		quantity: row.quantity,
		assignedAt: toIso(row.assigned_at),
		revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
	};
}

async function requireAutoTopupPolicy(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	policyId: string,
): Promise<AutoTopupPolicyRecord> {
	const row = await executeOne<{
		id: string | number | bigint;
		entity_external_id: string | null;
		feature_key: string;
		topup_key: string;
		provider: AutoTopupPolicyRecord["provider"];
		threshold_quantity: unknown;
		state_status: AutoTopupPolicyRecord["status"];
		cooldown_until: Date | string | null;
		consecutive_failures: number;
		active: boolean;
	}>(
		executor,
		drizzleSql`
		SELECT policy.id, entity.external_id AS entity_external_id, feature.key AS feature_key,
			option.key AS topup_key, policy.provider, policy.threshold_quantity::text AS threshold_quantity,
			state.status AS state_status, state.cooldown_until, state.consecutive_failures, policy.active
		FROM auto_topup_policies policy
		JOIN auto_topup_states state ON state.project_id = policy.project_id AND state.policy_id = policy.id
		JOIN features feature ON feature.project_id = policy.project_id AND feature.id = policy.feature_id
		JOIN topup_options option ON option.project_id = policy.project_id AND option.id = policy.topup_option_id
		LEFT JOIN entities entity ON entity.project_id = policy.project_id AND entity.id = policy.entity_id
		WHERE policy.project_id = ${projectId} AND policy.customer_id = ${customerId} AND policy.id = ${policyId}::bigint
	`,
	);
	if (row === null)
		throw new NotFoundBillingError(
			"Auto top-up policy was not found",
			"AUTO_TOPUP_POLICY_NOT_FOUND",
		);
	return {
		id: String(row.id),
		entityId: row.entity_external_id,
		featureKey: row.feature_key,
		topupKey: row.topup_key,
		provider: row.provider,
		thresholdQuantity: String(row.threshold_quantity),
		status: row.state_status,
		cooldownUntil: row.cooldown_until === null ? null : toIso(row.cooldown_until),
		consecutiveFailures: row.consecutive_failures,
		active: row.active,
	};
}

async function contractContext(
	executor: QueryExecutor,
	project: ProjectInstanceContext,
	input: EnterpriseContractInput,
) {
	const projectId = project.projectInstanceId;
	const customer = await requireCustomer(executor, projectId, input.billingAccountId);
	if (!Number.isInteger(input.version) || input.version < 1)
		throw new InvalidRequestError("Contract version must be positive");
	const effectiveAt = validDate(input.effectiveAt, "effectiveAt");
	const expiresAt = input.expiresAt == null ? null : validDate(input.expiresAt, "expiresAt");
	if (expiresAt !== null && expiresAt <= effectiveAt)
		throw new InvalidRequestError("Contract expiresAt must follow effectiveAt");
	const plan = await executeOne<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
		SELECT version.id FROM plans plan
		JOIN plan_versions version ON version.project_id = plan.project_id
			AND version.id = plan.active_version_id
		WHERE plan.project_id = ${projectId} AND plan.key = ${requiredText(input.planKey, "planKey", 120)}
			AND plan.active = true AND version.status = 'published'
			AND (version.visibility = 'public' OR version.customer_id = ${customer.id})
		LIMIT 1
	`,
	);
	if (plan === null)
		throw new NotFoundBillingError("Contract plan was not found", "BILLING_PLAN_NOT_FOUND");
	const controls = input.controls ?? [];
	const intent = {
		billingAccountId: requiredText(input.billingAccountId, "billingAccountId", 200),
		contractKey: requiredText(input.contractKey, "contractKey", 120),
		version: input.version,
		planKey: requiredText(input.planKey, "planKey", 120),
		effectiveAt: effectiveAt.toISOString(),
		expiresAt: expiresAt?.toISOString() ?? null,
		replacesCommercialDefaults: input.replacesCommercialDefaults ?? true,
		terms: input.terms ?? {},
		controls,
		actor: requiredText(input.actor, "actor", 200),
	};
	return { projectId, customerId: customer.id, planVersionId: String(plan.id), intent };
}

async function requireContract(
	executor: QueryExecutor,
	projectId: string,
	id: string,
): Promise<EnterpriseContractRecord> {
	const row = await executeOne<{
		id: string | number | bigint;
		contract_key: string;
		version: number;
		status: EnterpriseContractRecord["status"];
		plan_version_id: string | number | bigint;
		effective_at: Date | string;
		expires_at: Date | string | null;
		published_at: Date | string;
	}>(
		executor,
		drizzleSql`SELECT id, contract_key, version, status, plan_version_id, effective_at, expires_at, published_at FROM enterprise_contracts WHERE project_id = ${projectId} AND id = ${id}::bigint AND status <> 'draft'`,
	);
	if (row === null) throw new Error("Published contract was not found");
	return {
		id: String(row.id),
		contractKey: row.contract_key,
		version: row.version,
		status: row.status,
		planVersionId: String(row.plan_version_id),
		effectiveAt: toIso(row.effective_at),
		expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
		publishedAt: toIso(row.published_at),
	};
}

async function migrationContext(
	executor: QueryExecutor,
	project: ProjectInstanceContext,
	input: CatalogMigrationInput,
) {
	const projectId = project.projectInstanceId;
	const resolveVersion = async (key: string, version: number) => {
		if (!Number.isInteger(version) || version < 1)
			throw new InvalidRequestError("Plan version must be positive");
		const row = await executeOne<{
			id: string | number | bigint;
			plan_kind: "base" | "addon";
			visibility: "public" | "customer_specific";
			customer_id: string | null;
		}>(
			executor,
			drizzleSql`
			SELECT plan_version.id, plan_version.plan_kind, plan_version.visibility,
				plan_version.customer_id
			FROM plans plan
			JOIN plan_versions plan_version
				ON plan_version.project_id = plan.project_id AND plan_version.plan_id = plan.id
			WHERE plan.project_id = ${projectId} AND plan.key = ${requiredText(key, "planKey", 120)}
				AND plan_version.version = ${version} AND plan_version.status = 'published'
		`,
		);
		if (row === null)
			throw new NotFoundBillingError("Plan version was not found", "BILLING_PLAN_NOT_FOUND");
		return row;
	};
	const from = await resolveVersion(input.fromPlanKey, input.fromVersion);
	const target = await resolveVersion(input.toPlanKey, input.toVersion);
	const fromPlanVersionId = String(from.id);
	const toPlanVersionId = String(target.id);
	if (fromPlanVersionId === toPlanVersionId)
		throw new InvalidRequestError("Migration plan versions must differ");
	if (from.plan_kind !== target.plan_kind) {
		throw new InvalidRequestError("Migration plan versions must have the same plan kind");
	}
	const targetCustomerId = target.visibility === "customer_specific" ? target.customer_id : null;
	const count = await executeOne<{ count: string }>(
		executor,
		drizzleSql`
		SELECT count(*)::text AS count FROM subscriptions
		WHERE project_id = ${projectId} AND plan_version_id = ${fromPlanVersionId}::bigint
			AND status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
			AND (status <> 'cancelled' OR COALESCE(expires_at, current_period_end) > now())
			AND (${targetCustomerId}::uuid IS NULL OR customer_id = ${targetCustomerId}::uuid)
	`,
	);
	const intent = {
		fromPlanKey: input.fromPlanKey,
		fromVersion: input.fromVersion,
		toPlanKey: input.toPlanKey,
		toVersion: input.toVersion,
		effectiveMode: input.effectiveMode,
		actor: requiredText(input.actor, "actor", 200),
	};
	return {
		projectId,
		fromPlanVersionId,
		toPlanVersionId,
		targetCustomerId,
		matchingSubscriptions: Number(count?.count ?? 0),
		intent,
	};
}

async function insertAudit(
	executor: QueryExecutor,
	projectId: string,
	action: string,
	actor: string,
	details: Record<string, unknown>,
): Promise<void> {
	const revision = await executeOne<{ id: string | number | bigint; intent_hash: string }>(
		executor,
		drizzleSql`SELECT id, intent_hash FROM catalog_revisions WHERE project_id = ${projectId} AND status = 'published' ORDER BY revision DESC LIMIT 1`,
	);
	if (revision === null) return;
	await executeOne(
		executor,
		drizzleSql`INSERT INTO catalog_audit_log (project_id, catalog_revision_id, action, actor, intent_hash, details) VALUES (${projectId}, ${String(revision.id)}::bigint, ${action}, ${requiredText(actor, "actor", 200)}, ${revision.intent_hash}, ${jsonb(details)}) RETURNING id`,
	);
}

function requiredText(value: string, field: string, max: number): string {
	const normalized = value.trim();
	if (normalized === "" || normalized.length > max)
		throw new InvalidRequestError(`${field} must contain between 1 and ${max} characters`);
	return normalized;
}
function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new InvalidRequestError(`${field} must be between ${minimum} and ${maximum}`);
	return value;
}
function validDate(value: Date, field: string): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime()))
		throw new InvalidRequestError(`${field} must be a valid timestamp`);
	return value;
}
