import { previewExpiry } from "../../shared/preview-lifetime";

export const DEFAULT_MCP_PROPOSAL_TTL_SECONDS = 3600;

export function proposalTtlSeconds(value = DEFAULT_MCP_PROPOSAL_TTL_SECONDS): number {
	previewExpiry(value, Date.now(), "QUOTUM_MCP_PROPOSAL_TTL_SECONDS");
	return value;
}

export const MCP_PROPOSAL_LIMITS = {
	maxPending: 100,
	maxDaily: 1000,
	maxProposalBytes: 2_097_152,
	maxRetainedBytes: 67_108_864,
} as const;
export const MCP_RESULT_BYTES = 65_536;
export interface McpProposalLimits {
	maxPending: number;
	maxDaily: number;
	maxProposalBytes: number;
	maxRetainedBytes: number;
}
export function proposalLimits(overrides?: Partial<McpProposalLimits>): McpProposalLimits {
	const limits = { ...MCP_PROPOSAL_LIMITS, ...overrides };
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error(`MCP ${key} must be a positive safe integer`);
	}
	if (limits.maxPending > 2147483647 || limits.maxDaily > 2147483647)
		throw new Error("MCP proposal counts exceed the database integer range");
	if (limits.maxProposalBytes <= MCP_RESULT_BYTES + 1024)
		throw new Error("MCP proposal bytes must leave room for the execution receipt");
	if (limits.maxRetainedBytes < limits.maxProposalBytes)
		throw new Error("MCP retained bytes must cover one proposal");
	return limits;
}
export function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
/** A committed operation always gets a bounded receipt even if its returned resource is huge. */
export function boundedChangeResult<T extends { status: number; body: unknown }>(
	result: T,
	changeId: string,
):
	| T
	| {
			status: number;
			body: { responseOmitted: true; changeId: string; operationKey: string; reason: string };
	  } {
	if (jsonBytes(result) <= MCP_RESULT_BYTES) return result;
	return {
		status: result.status,
		body: {
			responseOmitted: true,
			changeId,
			operationKey: `mcp:${changeId}`,
			reason:
				"Execution response exceeded the retained receipt limit; inspect the affected resource using the proposal action and parameters.",
		},
	};
}
