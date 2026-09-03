import type { ProjectContext } from "../projects/context";

export type ControlKind = "spend_limit" | "usage_limit";
export type ControlInterval = "month" | "year" | "lifetime";
export type ControlSource = "plan_default" | "contract" | "account" | "entity";

export interface ControlPolicyInput {
	billingAccountId: string;
	entityId?: string | null;
	controlKind: ControlKind;
	featureKey?: string | null;
	currency?: string | null;
	limitValue: string;
	interval: ControlInterval;
	actor: string;
}

export interface EffectiveControl {
	controlKind: ControlKind;
	featureKey: string | null;
	currency: string | null;
	limitValue: string;
	interval: ControlInterval;
	source: ControlSource;
	revision: number;
	policyId: string;
	consumedValue: string;
	heldValue: string;
	remainingValue: string;
}

export interface EntityRecord {
	id: string;
	externalId: string;
	kind: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface UsageAlertInput {
	billingAccountId: string;
	entityId?: string | null;
	featureKey: string;
	thresholdType: "absolute" | "percentage";
	thresholdValue: string;
	interval: ControlInterval;
	actor: string;
	metadata?: Record<string, unknown>;
}

export interface UsageAlertRecord {
	id: string;
	entityId: string | null;
	featureKey: string;
	thresholdType: "absolute" | "percentage";
	thresholdValue: string;
	interval: ControlInterval;
	active: boolean;
	currentValue: string;
	crossed: boolean;
	createdAt: string;
}

export interface UsageAlertEvent {
	id: string;
	alertId: string;
	entityId: string | null;
	featureKey: string;
	eventType: "threshold_crossed" | "threshold_rearmed";
	currentValue: string;
	thresholdValue: string;
	windowStartAt: string;
	createdAt: string;
}

export interface AutoTopupPolicyInput {
	billingAccountId: string;
	entityId?: string | null;
	featureKey: string;
	topupKey: string;
	provider: "apple" | "google" | "stripe";
	thresholdQuantity: string;
	cooldownSeconds?: number;
	limitIntervalSeconds?: number;
	maxPurchasesPerInterval?: number;
	maxSpendMinor?: number | null;
	maxConsecutiveFailures?: number;
	actor: string;
}

export interface AutoTopupPolicyRecord {
	id: string;
	entityId: string | null;
	featureKey: string;
	topupKey: string;
	provider: "apple" | "google" | "stripe";
	thresholdQuantity: string;
	status: "ready" | "cooldown" | "suspended";
	cooldownUntil: string | null;
	consecutiveFailures: number;
	active: boolean;
}

export interface EnterpriseContractInput {
	billingAccountId: string;
	contractKey: string;
	version: number;
	planKey: string;
	effectiveAt: Date;
	expiresAt?: Date | null;
	replacesCommercialDefaults?: boolean;
	terms?: Record<string, unknown>;
	controls?: Array<Omit<ControlPolicyInput, "billingAccountId" | "entityId" | "actor">>;
	actor: string;
}

export interface EnterpriseContractPreview {
	previewToken: string;
	billingAccountId: string;
	contractKey: string;
	version: number;
	planVersionId: string;
	expiresAt: string;
	controls: number;
}

export interface EnterpriseContractRecord {
	id: string;
	contractKey: string;
	version: number;
	status: "published" | "expired" | "terminated";
	planVersionId: string;
	effectiveAt: string;
	expiresAt: string | null;
	publishedAt: string;
}

export interface CatalogMigrationInput {
	fromPlanKey: string;
	fromVersion: number;
	toPlanKey: string;
	toVersion: number;
	effectiveMode: "immediate" | "period_end";
	actor: string;
}

export interface CatalogMigrationPreview {
	previewToken: string;
	fromPlanVersionId: string;
	toPlanVersionId: string;
	matchingSubscriptions: number;
	expiresAt: string;
}

export interface CatalogMigrationResult extends CatalogMigrationPreview {
	queued: number;
	duplicate: boolean;
}

export interface LicensePoolRecord {
	id: string;
	externalSubscriptionId: string;
	featureKey: string;
	quantity: number;
	assignedQuantity: number;
	availableQuantity: number;
	active: boolean;
}

export interface LicenseAssignmentRecord {
	id: string;
	poolId: string;
	entityId: string;
	quantity: number;
	assignedAt: string;
	revokedAt: string | null;
}

export interface EntityLicenseDecision {
	entityId: string;
	featureKey: string;
	requiredQuantity: number;
	assignedQuantity: number;
	allowed: boolean;
}

export interface ControlsEnterpriseRepositoryLike {
	upsertControl(project: ProjectContext, input: ControlPolicyInput): Promise<EffectiveControl>;
	listEffectiveControls(
		project: ProjectContext,
		billingAccountId: string,
		entityId?: string | null,
	): Promise<EffectiveControl[]>;
	createEntity(
		project: ProjectContext,
		input: {
			billingAccountId: string;
			externalId: string;
			kind: string;
			metadata?: Record<string, unknown>;
		},
	): Promise<EntityRecord>;
	listEntities(project: ProjectContext, billingAccountId: string): Promise<EntityRecord[]>;
	createUsageAlert(project: ProjectContext, input: UsageAlertInput): Promise<UsageAlertRecord>;
	listUsageAlerts(project: ProjectContext, billingAccountId: string): Promise<UsageAlertRecord[]>;
	listUsageAlertEvents(
		project: ProjectContext,
		billingAccountId: string,
		limit: number,
	): Promise<UsageAlertEvent[]>;
	upsertAutoTopupPolicy(
		project: ProjectContext,
		input: AutoTopupPolicyInput,
	): Promise<AutoTopupPolicyRecord>;
	getAutoTopupPolicy(
		project: ProjectContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	): Promise<AutoTopupPolicyRecord | null>;
	resetAutoTopupCircuit(
		project: ProjectContext,
		billingAccountId: string,
		policyId: string,
		actor: string,
	): Promise<AutoTopupPolicyRecord>;
	previewEnterpriseContract(
		project: ProjectContext,
		input: EnterpriseContractInput,
	): Promise<EnterpriseContractPreview>;
	publishEnterpriseContract(
		project: ProjectContext,
		input: EnterpriseContractInput & { previewToken: string },
	): Promise<EnterpriseContractRecord>;
	listEnterpriseContracts(
		project: ProjectContext,
		billingAccountId: string,
	): Promise<EnterpriseContractRecord[]>;
	terminateEnterpriseContract(
		project: ProjectContext,
		billingAccountId: string,
		contractId: string,
		actor: string,
	): Promise<EnterpriseContractRecord>;
	previewCatalogMigration(
		project: ProjectContext,
		input: CatalogMigrationInput,
	): Promise<CatalogMigrationPreview>;
	publishCatalogMigration(
		project: ProjectContext,
		input: CatalogMigrationInput & { previewToken: string },
	): Promise<CatalogMigrationResult>;
	listLicensePools(project: ProjectContext, billingAccountId: string): Promise<LicensePoolRecord[]>;
	assignLicense(
		project: ProjectContext,
		input: {
			billingAccountId: string;
			poolId: string;
			entityId: string;
			quantity: number;
			actor: string;
		},
	): Promise<LicenseAssignmentRecord>;
	revokeLicense(
		project: ProjectContext,
		input: { billingAccountId: string; assignmentId: string; actor: string },
	): Promise<LicenseAssignmentRecord>;
	checkEntityLicense(
		project: ProjectContext,
		input: {
			billingAccountId: string;
			entityId: string;
			featureKey: string;
			requiredQuantity: number;
		},
	): Promise<EntityLicenseDecision>;
}

export class ControlsEnterpriseService {
	constructor(private readonly repository: ControlsEnterpriseRepositoryLike) {}

	upsertControl(project: ProjectContext, input: ControlPolicyInput) {
		return this.repository.upsertControl(project, input);
	}
	listEffectiveControls(
		project: ProjectContext,
		billingAccountId: string,
		entityId?: string | null,
	) {
		return this.repository.listEffectiveControls(project, billingAccountId, entityId);
	}
	createEntity(
		project: ProjectContext,
		input: Parameters<ControlsEnterpriseRepositoryLike["createEntity"]>[1],
	) {
		return this.repository.createEntity(project, input);
	}
	listEntities(project: ProjectContext, billingAccountId: string) {
		return this.repository.listEntities(project, billingAccountId);
	}
	createUsageAlert(project: ProjectContext, input: UsageAlertInput) {
		return this.repository.createUsageAlert(project, input);
	}
	listUsageAlerts(project: ProjectContext, billingAccountId: string) {
		return this.repository.listUsageAlerts(project, billingAccountId);
	}
	listUsageAlertEvents(project: ProjectContext, billingAccountId: string, limit: number) {
		return this.repository.listUsageAlertEvents(project, billingAccountId, limit);
	}
	upsertAutoTopupPolicy(project: ProjectContext, input: AutoTopupPolicyInput) {
		return this.repository.upsertAutoTopupPolicy(project, input);
	}
	getAutoTopupPolicy(
		project: ProjectContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	) {
		return this.repository.getAutoTopupPolicy(project, billingAccountId, featureKey, entityId);
	}
	resetAutoTopupCircuit(
		project: ProjectContext,
		billingAccountId: string,
		policyId: string,
		actor: string,
	) {
		return this.repository.resetAutoTopupCircuit(project, billingAccountId, policyId, actor);
	}
	previewEnterpriseContract(project: ProjectContext, input: EnterpriseContractInput) {
		return this.repository.previewEnterpriseContract(project, input);
	}
	publishEnterpriseContract(
		project: ProjectContext,
		input: EnterpriseContractInput & { previewToken: string },
	) {
		return this.repository.publishEnterpriseContract(project, input);
	}
	listEnterpriseContracts(project: ProjectContext, billingAccountId: string) {
		return this.repository.listEnterpriseContracts(project, billingAccountId);
	}
	terminateEnterpriseContract(
		project: ProjectContext,
		billingAccountId: string,
		contractId: string,
		actor: string,
	) {
		return this.repository.terminateEnterpriseContract(
			project,
			billingAccountId,
			contractId,
			actor,
		);
	}
	previewCatalogMigration(project: ProjectContext, input: CatalogMigrationInput) {
		return this.repository.previewCatalogMigration(project, input);
	}
	publishCatalogMigration(
		project: ProjectContext,
		input: CatalogMigrationInput & { previewToken: string },
	) {
		return this.repository.publishCatalogMigration(project, input);
	}
	listLicensePools(project: ProjectContext, billingAccountId: string) {
		return this.repository.listLicensePools(project, billingAccountId);
	}
	assignLicense(
		project: ProjectContext,
		input: Parameters<ControlsEnterpriseRepositoryLike["assignLicense"]>[1],
	) {
		return this.repository.assignLicense(project, input);
	}
	revokeLicense(
		project: ProjectContext,
		input: Parameters<ControlsEnterpriseRepositoryLike["revokeLicense"]>[1],
	) {
		return this.repository.revokeLicense(project, input);
	}
	checkEntityLicense(
		project: ProjectContext,
		input: Parameters<ControlsEnterpriseRepositoryLike["checkEntityLicense"]>[1],
	) {
		return this.repository.checkEntityLicense(project, input);
	}
}
