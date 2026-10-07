const usageKeyPrefix = "usage:";

/** The job key that coalesces a customer's usage-driven projections. It is never sent to a receiver. */
export function usageProjectionKey(customerId: string): string {
	return `${usageKeyPrefix}${customerId}`;
}

/** The key a receiver sees: each delivered snapshot has its own sequence. */
export function usageDeliveryKey(customerId: string, sequence: number): string {
	return `${usageProjectionKey(customerId)}:${sequence}`;
}

export function isUsageKey(key: string): boolean {
	return key.startsWith(usageKeyPrefix);
}

/** The SQL literal that prefixes a usage job's key; a constant, never caller input. */
export const usageKeySqlPrefix = `'${usageKeyPrefix}'`;
