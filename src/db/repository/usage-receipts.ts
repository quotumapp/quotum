import { sql } from "drizzle-orm";
import { InvalidRequestError, NotFoundBillingError } from "../../billing/errors";
import type { ConsumeUsageResult } from "../../billing/metering";
import {
	type UsageConsumeInput,
	type UsageConsumeResult,
	type UsageDeductionPage,
	type UsageReceipt,
	type UsageReceiptInput,
	usageContext,
	usageVerdict,
} from "../../billing/usage-api";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { requireBillingAccount } from "./billing-accounts";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

export function receiptId(id: string, recordedAt: string): string {
	return `ur_${Buffer.from(JSON.stringify([id, recordedAt])).toString("base64url")}`;
}

export function parseReceiptId(value: string): { id: string; recordedAt: string } {
	try {
		if (!/^ur_[A-Za-z0-9_-]{1,500}$/.test(value)) throw new Error();
		const decoded: unknown = JSON.parse(Buffer.from(value.slice(3), "base64url").toString());
		if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error();
		const [id, recordedAt] = decoded as unknown[];
		if (
			typeof id !== "string" ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ||
			typeof recordedAt !== "string" ||
			!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(
				recordedAt,
			) ||
			!Number.isFinite(Date.parse(recordedAt)) ||
			receiptId(id, recordedAt) !== value
		)
			throw new Error();
		return { id, recordedAt };
	} catch {
		throw new InvalidRequestError("Invalid receiptId");
	}
}

/** The snapshot, deductions, operation outcome, ledger and projection commit together. */
export async function persistUsageReceipt(
	tx: QueryExecutor,
	projectId: string,
	input: UsageConsumeInput,
	unit: string,
	result: ConsumeUsageResult,
): Promise<UsageConsumeResult> {
	const context = usageContext(input, unit, result);
	const verdict = usageVerdict(result);
	const identity = { operation: "consume" as const, operationId: input.operationId };
	if (!verdict.allowed) return { ...context, ...identity, ...verdict };
	if (
		result.usageEventId === null ||
		result.recordedAt === null ||
		result.recordedAtExact === undefined
	) {
		throw new Error("Committed usage is missing its event identity");
	}
	const id = receiptId(result.usageEventId, result.recordedAtExact);
	const receipt: UsageReceipt = {
		...context,
		...identity,
		receiptId: id,
		usageEventId: result.usageEventId,
		billingAccountId: input.billingAccountId,
		occurredAt: input.occurredAt?.toISOString() ?? null,
		recordedAt: result.recordedAt,
		rating: { path: result.rateCard.path, revision: result.rateCard.revision },
		deductionCount: result.deductions.length,
	};
	const saved = await executeOne<{ id: string }>(
		tx,
		sql`
		UPDATE usage_events SET receipt = ${jsonb(receipt)}
		WHERE project_id = ${projectId} AND id = ${result.usageEventId}
		AND recorded_at = ${result.recordedAtExact}::timestamptz AND receipt IS NULL
		RETURNING id
	`,
	);
	if (saved === null) throw new Error("Usage receipt could not be persisted");
	return {
		...context,
		...identity,
		allowed: true,
		receiptId: id,
		usageEventId: result.usageEventId,
		recordedAt: result.recordedAt,
	};
}

export class UsageReceiptRepository extends RepositoryModule {
	async get(project: ProjectInstanceContext, input: UsageReceiptInput): Promise<UsageReceipt> {
		const { id, recordedAt } = parseReceiptId(input.receiptId);
		const customer = await requireBillingAccount(
			this.database,
			project.projectInstanceId,
			input.billingAccountId,
		);
		const row = await executeOne<{ receipt: UsageReceipt }>(
			this.database,
			sql`
			SELECT receipt FROM usage_events
			WHERE project_id = ${project.projectInstanceId} AND customer_id = ${customer.id}
			AND id = ${id} AND recorded_at = ${recordedAt}::timestamptz
			AND receipt IS NOT NULL AND (receipt->>'entityId') IS NOT DISTINCT FROM ${input.entityId ?? null}::text
		`,
		);
		if (row === null)
			throw new NotFoundBillingError("Usage receipt was not found", "RECEIPT_NOT_FOUND");
		return row.receipt;
	}

	async listDeductions(
		project: ProjectInstanceContext,
		input: UsageReceiptInput & { cursor?: string; limit?: number },
	): Promise<UsageDeductionPage> {
		const receipt = await this.get(project, input);
		const limit = input.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new InvalidRequestError("limit must be between 1 and 100");
		let offset = 0;
		if (input.cursor !== undefined) {
			try {
				if (input.cursor.length > 1024) throw new Error();
				const cursor: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
				if (
					!Array.isArray(cursor) ||
					cursor.length !== 2 ||
					cursor[0] !== input.receiptId ||
					!Number.isSafeInteger(cursor[1]) ||
					cursor[1] < 0 ||
					cursor[1] > receipt.deductionCount
				)
					throw new Error();
				offset = cursor[1];
			} catch {
				throw new InvalidRequestError("Invalid receipt deduction cursor");
			}
		}
		const { id, recordedAt } = parseReceiptId(input.receiptId);
		const rows = await executeRows<{
			item: { sourceKind: string; sourceKey: string; quantity: string; expiresAt: string | null };
		}>(
			this.database,
			sql`
			SELECT deduction.item FROM usage_events event
			CROSS JOIN LATERAL jsonb_array_elements(event.deductions) WITH ORDINALITY AS deduction(item, position)
			WHERE event.project_id = ${project.projectInstanceId} AND event.id = ${id}
			AND event.recorded_at = ${recordedAt}::timestamptz
			AND event.receipt->>'billingAccountId' = ${input.billingAccountId}
			AND (event.receipt->>'entityId') IS NOT DISTINCT FROM ${input.entityId ?? null}::text
			AND deduction.position > ${offset} ORDER BY deduction.position LIMIT ${limit + 1}
		`,
		);
		return {
			items: rows.slice(0, limit).map(({ item }) => ({
				sourceKind: item.sourceKind,
				sourceKey: item.sourceKey,
				value: item.quantity,
				expiresAt: item.expiresAt,
			})),
			nextCursor:
				rows.length > limit
					? Buffer.from(JSON.stringify([input.receiptId, offset + limit])).toString("base64url")
					: null,
		};
	}
}
