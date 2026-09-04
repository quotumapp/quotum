export type PlatformQueryValue = string | number | boolean | Date | Uint8Array | null;

export interface PlatformQuery {
	text: string;
	values: readonly PlatformQueryValue[];
}

export interface PlatformQueryExecutor {
	query<Row>(query: PlatformQuery): Promise<readonly Row[]>;
}
