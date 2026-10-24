import type { MerchantSql } from "../database";
import { MerchantError } from "../security";
import type { McpProposalLimits } from "./proposal-limits";
/** Caller holds organization, membership and authorization locks in that order. */
export async function reserveProposal(
	tx: MerchantSql,
	input: {
		organizationId: string;
		authorizationId: string;
		requestKey: string;
		hash: string;
		limits: McpProposalLimits;
	},
): Promise<string> {
	const { organizationId, authorizationId, requestKey, hash, limits } = input;
	await tx`DELETE FROM platform_mcp_proposal_admissions WHERE organization_id=${organizationId} AND expires_at<=clock_timestamp()`;
	const [existing] = await tx<
		{ request_hash: string }[]
	>`SELECT request_hash FROM platform_mcp_proposal_admissions WHERE authorization_id=${authorizationId} AND request_key=${requestKey}`;
	if (existing)
		throw new MerchantError(
			existing.request_hash === hash ? "OPERATION_IN_PROGRESS" : "IDEMPOTENCY_CONFLICT",
			"A preparation already holds this request key.",
			409,
		);
	const [usage] = await tx<
		{ pending: number; bytes: string }[]
	>`SELECT count(*) FILTER (WHERE status IN ('pending','applying') AND expires_at>clock_timestamp())::int AS pending,COALESCE(sum(storage_bytes),0)::text AS bytes FROM platform_mcp_changes WHERE organization_id=${organizationId}`;
	const [held] = await tx<
		{ count: number; bytes: string }[]
	>`SELECT count(*)::int AS count,COALESCE(sum(reserved_bytes),0)::text AS bytes FROM platform_mcp_proposal_admissions WHERE organization_id=${organizationId}`;
	const [day] = await tx<
		{ attempts: number }[]
	>`SELECT attempts FROM platform_mcp_proposal_days WHERE organization_id=${organizationId} AND day=(clock_timestamp() AT TIME ZONE 'UTC')::date`;
	if (
		Number(usage?.pending ?? 0) + Number(held?.count ?? 0) >= limits.maxPending ||
		Number(day?.attempts ?? 0) >= limits.maxDaily ||
		Number(usage?.bytes ?? 0) + Number(held?.bytes ?? 0) + limits.maxProposalBytes >
			limits.maxRetainedBytes
	)
		throw new MerchantError(
			"MCP_QUOTA_EXCEEDED",
			"This organization has reached its proposal quota. Resolve pending proposals or wait for retention/daily reset.",
			429,
		);
	await tx`INSERT INTO platform_mcp_proposal_days(organization_id,day,attempts) VALUES(${organizationId},(clock_timestamp() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(organization_id,day) DO UPDATE SET attempts=platform_mcp_proposal_days.attempts+1`;
	const [ticket] = await tx<
		{ id: string }[]
	>`INSERT INTO platform_mcp_proposal_admissions(organization_id,authorization_id,request_key,request_hash,reserved_bytes) VALUES(${organizationId},${authorizationId},${requestKey},${hash},${limits.maxProposalBytes}) RETURNING id`;
	if (!ticket) throw new Error("Missing proposal admission");
	return ticket.id;
}
