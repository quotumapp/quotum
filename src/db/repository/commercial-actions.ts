import { sql as drizzleSql } from "drizzle-orm";
import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
	CommercialPreviewDraft,
	StoredCommercialActionPreview,
} from "../../billing/commercial";
import { InvalidRequestError, PersistenceConflictError } from "../../billing/errors";
import type { ProjectContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { resolveProjectId } from "./identities";
import { executeOne, jsonb } from "./query";

interface PreviewRow {
	intent: CommercialActionIntent;
	preview: CommercialActionPreview;
	intent_hash: string;
	state_fingerprint: string;
	status: "previewed" | "executing" | "executed";
	execution_idempotency_key: string | null;
	execution_result: CommercialActionExecutionResult | null;
	expires_at: Date | string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CommercialActionRepository extends RepositoryModule {
	async createCommercialActionPreview(
		project: ProjectContext,
		draft: CommercialPreviewDraft,
	): Promise<CommercialActionPreview> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const previewToken = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 15 * 60_000);
			const preview: CommercialActionPreview = {
				...draft.preview,
				previewToken,
				expiresAt: expiresAt.toISOString(),
			};
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO commercial_action_previews (
						project_id, billing_account_id, preview_token, intent_kind,
						intent_hash, state_fingerprint, intent, preview, expires_at
					) VALUES (
						${projectId}, ${draft.billingAccountId}, ${previewToken}, ${draft.intent.kind},
						${draft.intentHash}, ${draft.stateFingerprint}, ${jsonb(draft.intent)},
						${jsonb(preview)}, ${expiresAt.toISOString()}
					)
					RETURNING id
				`,
			);
			return preview;
		});
	}

	async getCommercialActionPreview(
		project: ProjectContext,
		billingAccountId: string,
		previewToken: string,
	): Promise<StoredCommercialActionPreview> {
		const projectId = await resolveProjectId(this.database, project);
		const row = await previewRow(this.database, projectId, billingAccountId, previewToken, false);
		return storedPreview(row);
	}

	async beginCommercialActionExecution(
		project: ProjectContext,
		input: {
			billingAccountId: string;
			previewToken: string;
			intentHash: string;
			stateFingerprint: string;
			idempotencyKey: string;
		},
	): Promise<StoredCommercialActionPreview> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const row = await previewRow(tx, projectId, input.billingAccountId, input.previewToken, true);
			if (row.intent_hash !== input.intentHash) {
				throw new PersistenceConflictError(
					"Commercial action intent differs from its preview",
					"COMMERCIAL_PREVIEW_MISMATCH",
				);
			}
			if (row.state_fingerprint !== input.stateFingerprint) {
				throw new PersistenceConflictError(
					"Customer or catalog state changed after preview",
					"COMMERCIAL_PREVIEW_STALE",
				);
			}
			if (
				row.execution_idempotency_key !== null &&
				row.execution_idempotency_key !== input.idempotencyKey
			) {
				throw new PersistenceConflictError(
					"Commercial action execution is already bound to another idempotency key",
					"IDEMPOTENCY_CONFLICT",
				);
			}
			if (row.status === "executed") return storedPreview(row);
			if (row.status === "previewed" && new Date(row.expires_at).getTime() <= Date.now()) {
				throw new PersistenceConflictError(
					"Commercial action preview has expired",
					"COMMERCIAL_PREVIEW_EXPIRED",
				);
			}
			const updated = await executeOne<PreviewRow>(
				tx,
				drizzleSql`
					UPDATE commercial_action_previews
					SET status = 'executing', execution_idempotency_key = ${input.idempotencyKey},
						updated_at = now()
					WHERE project_id = ${projectId} AND preview_token = ${input.previewToken}
					RETURNING intent, preview, intent_hash, state_fingerprint, status,
						execution_idempotency_key, execution_result, expires_at
				`,
			);
			if (updated === null) throw new Error("Commercial action preview could not be claimed");
			return storedPreview(updated);
		});
	}

	async completeCommercialActionExecution(
		project: ProjectContext,
		input: {
			billingAccountId: string;
			previewToken: string;
			idempotencyKey: string;
			result: CommercialActionExecutionResult;
		},
	): Promise<CommercialActionExecutionResult> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const row = await executeOne<{ execution_result: CommercialActionExecutionResult }>(
				tx,
				drizzleSql`
					UPDATE commercial_action_previews
					SET status = 'executed', execution_result = ${jsonb(input.result)},
						executed_at = now(), updated_at = now()
					WHERE project_id = ${projectId}
						AND billing_account_id = ${input.billingAccountId}
						AND preview_token = ${input.previewToken}
						AND status IN ('executing', 'executed')
						AND execution_idempotency_key = ${input.idempotencyKey}
					RETURNING execution_result
				`,
			);
			if (row === null) {
				throw new PersistenceConflictError(
					"Commercial action execution ownership was lost",
					"COMMERCIAL_EXECUTION_CONFLICT",
				);
			}
			return row.execution_result;
		});
	}
}

async function previewRow(
	executor: Parameters<typeof resolveProjectId>[0],
	projectId: string,
	billingAccountId: string,
	previewToken: string,
	lock: boolean,
): Promise<PreviewRow> {
	if (!uuidPattern.test(previewToken)) {
		throw new InvalidRequestError("previewToken must be a UUID");
	}
	const row = await executeOne<PreviewRow>(
		executor,
		drizzleSql`
			SELECT intent, preview, intent_hash, state_fingerprint, status,
				execution_idempotency_key, execution_result, expires_at
			FROM commercial_action_previews
			WHERE project_id = ${projectId}
				AND billing_account_id = ${billingAccountId}
				AND preview_token = ${previewToken}
			${lock ? drizzleSql`FOR UPDATE` : drizzleSql``}
		`,
	);
	if (row === null) {
		throw new PersistenceConflictError(
			"Commercial action preview was not found",
			"COMMERCIAL_PREVIEW_NOT_FOUND",
		);
	}
	return row;
}

function storedPreview(row: PreviewRow): StoredCommercialActionPreview {
	return {
		intent: row.intent,
		preview: row.preview,
		status: row.status,
		executionIdempotencyKey: row.execution_idempotency_key,
		executionResult: row.execution_result,
	};
}
