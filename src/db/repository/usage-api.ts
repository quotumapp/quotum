import { InvalidRequestError } from "../../billing/errors";
import {
	publicUsageValue,
	type UsageApiServiceLike,
	type UsageCheckInput,
	type UsageCheckResult,
	type UsageConsumeInput,
	usageContext,
	usageVerdict,
} from "../../billing/usage-api";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { BillingAccountRepository, requireBillingAccount } from "./billing-accounts";
import { getEntitlementSnapshot } from "./entitlements";
import { MeteringBillingRepository } from "./metering";
import { requireActiveFeature, resolveEntityId } from "./metering-persistence";
import type { TransactionalQueryExecutor } from "./types";
import { UsageReceiptRepository } from "./usage-receipts";

export class UsageApiRepository extends RepositoryModule implements UsageApiServiceLike {
	private readonly accounts: BillingAccountRepository;
	private readonly metering: MeteringBillingRepository;
	private readonly receipts: UsageReceiptRepository;
	constructor(database: TransactionalQueryExecutor) {
		super(database);
		this.accounts = new BillingAccountRepository(database);
		this.metering = new MeteringBillingRepository(database);
		this.receipts = new UsageReceiptRepository(database);
	}
	createAccount: UsageApiServiceLike["createAccount"] = (project, id) =>
		this.accounts.create(project, id);
	getAccount: UsageApiServiceLike["getAccount"] = (project, id) => this.accounts.get(project, id);
	getReceipt: UsageApiServiceLike["getReceipt"] = (project, input) =>
		this.receipts.get(project, input);
	listReceiptDeductions: UsageApiServiceLike["listReceiptDeductions"] = (project, input) =>
		this.receipts.listDeductions(project, input);

	async check(project: ProjectInstanceContext, input: UsageCheckInput): Promise<UsageCheckResult> {
		const projectId = project.projectInstanceId;
		const account = await requireBillingAccount(this.database, projectId, input.billingAccountId);
		await resolveEntityId(this.database, projectId, account.id, input.entityId);
		const feature = await requireActiveFeature(this.database, projectId, input.featureId);
		if (feature.kind === "boolean") {
			if (input.value !== undefined || input.occurredAt !== undefined)
				throw new InvalidRequestError("Boolean checks omit value and occurredAt");
			const snapshot = await getEntitlementSnapshot(
				this.database,
				projectId,
				input.billingAccountId,
			);
			const context = {
				kind: "boolean" as const,
				featureId: feature.key,
				entityId: input.entityId ?? null,
				checkedAt: snapshot.generatedAt,
			};
			return snapshot.entitlements.some((entry) => entry.key === feature.key && entry.active)
				? { ...context, allowed: true }
				: { ...context, allowed: false, reason: "not_entitled" };
		}
		if (feature.kind !== "metered")
			throw new InvalidRequestError(
				"Feature does not support usage checks",
				"FEATURE_OPERATION_UNSUPPORTED",
			);
		if (input.value === undefined) throw new InvalidRequestError("Metered checks require value");
		const decision = await this.metering.check(project, {
			billingAccountId: input.billingAccountId,
			featureKey: input.featureId,
			quantity: publicUsageValue(input.value),
			entityId: input.entityId,
			occurredAt: input.occurredAt,
		});
		return {
			...usageContext(input, feature.unit, decision),
			...usageVerdict(decision),
			kind: "metered",
			checkedAt: new Date().toISOString(),
		};
	}

	async consume(project: ProjectInstanceContext, input: UsageConsumeInput) {
		return this.metering.consumePublic(project, input);
	}
}
