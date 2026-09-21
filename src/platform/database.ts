import type {
	CreatePlatformProjectInstanceInput,
	PlatformProjectInstanceRecord,
	PlatformProjectWithInstancesRecord,
} from "./application/ports";
import type { PlatformQueryExecutor, PlatformQueryValue } from "./persistence/query-executor";

/** Platform-owned persistence port. Composition supplies the driver and transaction-bound instance seam. */
export interface MerchantSql extends PlatformQueryExecutor {
	<Rows extends object[] = Record<string, unknown>[]>(
		strings: TemplateStringsArray,
		...values: PlatformQueryValue[]
	): Promise<Rows>;
	begin<Result>(work: (transaction: MerchantSql) => Promise<Result>): Promise<Result>;
	instances: {
		forProject(platformProjectId: string): Promise<readonly PlatformProjectInstanceRecord[]>;
		/** Every project the principal can see, with its instances, in one statement. */
		forPrincipal(principalId: string): Promise<readonly PlatformProjectWithInstancesRecord[]>;
		activateProduction(
			instanceId: string,
			organizationId: string,
			catalogRevisionId: string,
		): Promise<boolean>;
		create(input: CreatePlatformProjectInstanceInput): Promise<PlatformProjectInstanceRecord>;
	};
}
