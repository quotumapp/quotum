import { sql } from "drizzle-orm";
import {
	type ProjectionSubscriptionPayload,
	projectionSubscriptionSchema,
} from "../../billing/types";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/** Read the accepted state, including the pinned plan, rather than the triggering event. */
export async function readSubscriptionProjection(
	executor: QueryExecutor,
	projectId: string,
	subscriptionId: string,
): Promise<ProjectionSubscriptionPayload> {
	const row = await executeOne(
		executor,
		sql`
		SELECT jsonb_build_object(
			'subscriptionId', s.id, 'externalSubscriptionId', s.external_subscription_id,
			'provider', s.provider, 'channel', s.channel, 'productKey', p.key,
			'planKey', pl.key, 'status', s.status, 'providerStatus', s.provider_status,
			'expiresAt', to_char(s.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'cancelAtPeriodEnd', s.cancel_at_period_end,
			'cancellationReason', s.raw_state->>'cancellationReason'
		) AS fact
		FROM subscriptions s
		JOIN products p ON p.project_id = s.project_id AND p.id = s.product_id
		LEFT JOIN plan_versions pv ON pv.project_id = s.project_id AND pv.id = s.plan_version_id
		LEFT JOIN plans pl ON pl.project_id = pv.project_id AND pl.id = pv.plan_id
		WHERE s.project_id = ${projectId} AND s.id = ${subscriptionId}
	`,
	);
	return projectionSubscriptionSchema.parse(row?.fact);
}
