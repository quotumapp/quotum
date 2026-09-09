import type {
	CreatePlatformProjectInstanceInput,
	PlatformProjectInstanceRecord,
} from "./application/ports";
import type { PlatformQueryValue } from "./persistence/query-executor";

/** Platform-owned persistence port. Composition supplies the driver and transaction-bound instance seam. */
export interface MerchantSql {
	<Rows extends object[] = Record<string, unknown>[]>(
		strings: TemplateStringsArray,
		...values: PlatformQueryValue[]
	): Promise<Rows>;
	begin<Result>(work: (transaction: MerchantSql) => Promise<Result>): Promise<Result>;
	instances: {
		forProject(platformProjectId: string): Promise<readonly PlatformProjectInstanceRecord[]>;
		activateProduction(
			instanceId: string,
			organizationId: string,
			catalogRevisionId: string,
		): Promise<boolean>;
		create(input: CreatePlatformProjectInstanceInput): Promise<PlatformProjectInstanceRecord>;
	};
}
