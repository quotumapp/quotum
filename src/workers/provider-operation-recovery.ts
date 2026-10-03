import {
	type ProviderOperationRecoveryStore,
	reconcileProviderOperation,
} from "../billing/provider-operations";
import type { ProjectInstanceContextResolver } from "../projects/context";

type Recovery = Parameters<typeof reconcileProviderOperation>[0];
export interface ProviderOperationRecoveryRepository extends ProviderOperationRecoveryStore {
	deferRecovery(projectId: string, id: string): Promise<void>;
	due(limit: number): Promise<{ project_id: string; billing_account_id: string; id: string }[]>;
}

/** Read-only provider observations. Expired dispatch leases never become dispatchable again. */
export class ProviderOperationRecoveryWorker {
	constructor(
		private readonly options: {
			repository: ProviderOperationRecoveryRepository;
			projects: ProjectInstanceContextResolver;
			resolve: (
				project: Recovery["project"],
				operation: Parameters<Recovery["resolve"]>[0],
			) => ReturnType<Recovery["resolve"]>;
			batchSize?: number;
		},
	) {}
	async runOnce() {
		let recovered = 0;
		let unresolved = 0;
		const due = await this.options.repository.due(this.options.batchSize ?? 10);
		for (const row of due) {
			const lookup = await this.options.projects.resolveInstanceId(row.project_id);
			if (lookup.kind !== "resolved") {
				await this.options.repository.deferRecovery(row.project_id, row.id);
				unresolved++;
				continue;
			}
			const operation = await reconcileProviderOperation({
				project: lookup.context,
				store: this.options.repository,
				billingAccountId: row.billing_account_id,
				operationId: row.id,
				resolve: (operation) => this.options.resolve(lookup.context, operation),
			});
			if (operation.status === "succeeded") recovered++;
			else unresolved++;
		}
		return { selected: due.length, recovered, unresolved };
	}
}
