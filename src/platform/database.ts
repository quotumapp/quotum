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
		create(input: CreatePlatformProjectInstanceInput): Promise<PlatformProjectInstanceRecord>;
		/** Moves one `active` instance to `suspended`; false when it was not active. */
		suspend(instanceId: string, organizationId: string): Promise<boolean>;
		/** Moves one `suspended` instance back to `active`; false when it was not suspended. */
		resume(instanceId: string, organizationId: string): Promise<boolean>;
		/** Sets the display name of every non-internal instance of a logical project. */
		renameForProject(
			platformProjectId: string,
			organizationId: string,
			name: string,
		): Promise<void>;
	};
}
