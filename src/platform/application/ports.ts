import type { PlatformQueryExecutor } from "../persistence/query-executor";

export interface PlatformProjectInstanceRecord {
	id: string;
	platformProjectId: string;
	key: string;
	name: string;
	environment: "sandbox" | "production" | "internal";
	lifecycleStatus: "inactive" | "active" | "suspended" | "deactivating" | "deactivated";
	internalProject: boolean;
}

export interface CreatePlatformProjectInstanceInput {
	platformProjectId: string;
	key: string;
	name: string;
	environment: PlatformProjectInstanceRecord["environment"];
	lifecycleStatus: PlatformProjectInstanceRecord["lifecycleStatus"];
	internalProject: boolean;
}

export interface PlatformProjectInstanceStore {
	list(): Promise<readonly PlatformProjectInstanceRecord[]>;
	create(input: CreatePlatformProjectInstanceInput): Promise<PlatformProjectInstanceRecord>;
}

export interface PlatformTransactionResources {
	executor: PlatformQueryExecutor;
	projectInstances: PlatformProjectInstanceStore;
}

export interface PlatformUnitOfWork {
	transaction<Result>(
		work: (resources: PlatformTransactionResources) => Promise<Result>,
	): Promise<Result>;
}
