import type { ProjectInstanceContext } from "../projects/context";
import { BillingError } from "./errors";
import type { EntitlementSnapshot } from "./types";

export interface EntitlementRepository {
	getEntitlementSnapshot(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<EntitlementSnapshot>;
}

export class EntitlementService {
	constructor(private readonly repository: EntitlementRepository) {}

	async getSnapshot(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<EntitlementSnapshot> {
		const normalizedUserId = billingAccountId.trim();
		if (!normalizedUserId) {
			throw new BillingError("billingAccountId is required", "INVALID_BILLING_ACCOUNT_ID", 400);
		}

		return this.repository.getEntitlementSnapshot(project, normalizedUserId);
	}
}
