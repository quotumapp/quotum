import type { PlatformQueryExecutor } from "../persistence/query-executor";
import { MerchantError } from "../security";
import type { ConnectionCipher, SecretEnvelope } from "./cipher";

export type ConnectionKind = "stripe" | "apple" | "google" | "projection";
export interface ConnectionVersion {
	id: string;
	connection_id: string;
	project_instance_id: string;
	expected_revision: number;
	settings: Record<string, unknown>;
	status: "draft" | "validated" | "active" | "retired" | "expired";
	validated_at: Date | null;
	event_verified_at: Date | null;
	validation: Record<string, unknown> | null;
	external_identity: string | null;
	expires_at: Date;
}
/** Non-secret state of one connection and its active version, if any. */
export interface ConnectionDescriptionRow {
	enabled: boolean;
	active_version_id: string | null;
	settings: Record<string, unknown> | null;
	validated_at: Date | null;
	external_identity: string | null;
}
export class ConnectionRepository {
	constructor(
		readonly executor: PlatformQueryExecutor,
		readonly cipher: ConnectionCipher,
	) {}
	async matchesKind(connectionId: string, kind: ConnectionKind) {
		const rows = await this.executor.query<{ id: string }>({
			text: `
				SELECT id
				FROM platform_connections
				WHERE id = $1 AND kind = $2
			`,
			values: [connectionId, kind],
		});
		return rows.length > 0;
	}
	async recordEvent(version: ConnectionVersion, identity: string, occurred: Date) {
		const rows = await this.executor.query<{ id: string }>({
			text: `
				UPDATE platform_connection_versions
				SET event_verified_at = now()
				WHERE id = $1
					AND connection_id = $2
					AND (external_identity IS NULL OR external_identity = $3)
					AND created_at <= $4
					AND (status = 'active' OR (status IN ('draft', 'validated') AND expires_at > now()))
				RETURNING id
			`,
			values: [version.id, version.connection_id, identity, occurred.toISOString()],
		});
		return rows.length > 0;
	}
	async active(
		instanceId: string,
		kind: ConnectionKind,
		recovery = false,
	): Promise<{ version: ConnectionVersion; secrets: Record<string, string> } | null> {
		const [version] = await this.executor.query<ConnectionVersion>({
			text: `
				SELECT v.*
				FROM platform_connections c
				JOIN platform_connection_versions v
					ON v.connection_id = c.id AND v.id = c.active_version_id
				WHERE c.project_instance_id = $1
					AND c.kind = $2
					AND (c.enabled OR $3::boolean)
			`,
			values: [instanceId, kind, recovery],
		});
		if (!version) return null;
		return { version, secrets: await this.secrets(version) };
	}
	/** Reads persisted state only: never secrets, the cipher or a provider. Null when no row exists. */
	async describe(
		instanceId: string,
		kind: ConnectionKind,
	): Promise<ConnectionDescriptionRow | null> {
		const [row] = await this.executor.query<ConnectionDescriptionRow>({
			text: `
				SELECT c.enabled, c.active_version_id, v.settings, v.validated_at, v.external_identity
				FROM platform_connections c
				LEFT JOIN platform_connection_versions v
					ON v.connection_id = c.id AND v.id = c.active_version_id
				WHERE c.project_instance_id = $1 AND c.kind = $2
			`,
			values: [instanceId, kind],
		});
		return row ?? null;
	}
	async version(
		instanceId: string,
		id: string,
		executor: PlatformQueryExecutor = this.executor,
	): Promise<ConnectionVersion> {
		const [version] = await executor.query<ConnectionVersion>({
			text: `
				SELECT *
				FROM platform_connection_versions
				WHERE id = $1 AND project_instance_id = $2
			`,
			values: [id, instanceId],
		});
		if (!version)
			throw new MerchantError("CONNECTION_NOT_FOUND", "Connection draft is unavailable.", 404);
		return version;
	}
	async secrets(version: ConnectionVersion): Promise<Record<string, string>> {
		const rows = await this.executor.query<{
			purpose: string;
			envelope: SecretEnvelope;
		}>({
			text: `
				SELECT purpose, envelope
				FROM platform_connection_secrets
				WHERE connection_id = $1 AND version_id = $2
			`,
			values: [version.connection_id, version.id],
		});
		try {
			const [connection] = await this.executor.query<{ kind: ConnectionKind }>({
				text: `
					SELECT kind
					FROM platform_connections
					WHERE id = $1
				`,
				values: [version.connection_id],
			});
			const purposes: Record<ConnectionKind, string[]> = {
				stripe:
					version.settings.authMethod === "oauth"
						? ["accessToken", "refreshToken", "expiresAt"]
						: ["secretKey", "webhookSecret"],
				apple: ["privateKey"],
				google: ["serviceAccountJson", "obfuscatedAccountIdSecret"],
				projection: ["projectionSecret"],
			};
			if (
				!connection ||
				purposes[connection.kind].some((purpose) => !rows.some((row) => row.purpose === purpose))
			)
				throw new Error("Missing connection secret");
			return Object.fromEntries(
				rows.map((row) => [
					row.purpose,
					this.cipher.decrypt(row.envelope, {
						instanceId: version.project_instance_id,
						connectionId: version.connection_id,
						versionId: version.id,
						purpose: row.purpose,
					}),
				]),
			);
		} catch {
			throw new MerchantError(
				"CONNECTION_SECRET_UNAVAILABLE",
				"Reconnect this integration or restore its encryption key.",
				503,
			);
		}
	}
	async saveSecrets(
		executor: PlatformQueryExecutor,
		version: Pick<ConnectionVersion, "id" | "connection_id" | "project_instance_id">,
		values: Record<string, string>,
	): Promise<void> {
		for (const [purpose, value] of Object.entries(values)) {
			const envelope = this.cipher.encrypt(value, {
				instanceId: version.project_instance_id,
				connectionId: version.connection_id,
				versionId: version.id,
				purpose,
			});
			await executor.query({
				text: `
					INSERT INTO platform_connection_secrets(connection_id, version_id, purpose, envelope)
					VALUES ($1, $2, $3, $4::text::jsonb)
				`,
				values: [version.connection_id, version.id, purpose, JSON.stringify(envelope)],
			});
		}
	}
	async list(instanceId: string) {
		return this.executor.query<{
			id: string;
			kind: ConnectionKind;
			revision: number;
			enabled: boolean;
			active_version_id: string | null;
			settings: Record<string, unknown> | null;
			validated_at: Date | null;
			event_verified_at: Date | null;
		}>({
			text: `
				SELECT
					c.id,
					c.kind,
					c.revision,
					c.enabled,
					c.active_version_id,
					v.settings,
					v.validated_at,
					v.event_verified_at
				FROM platform_connections c
				LEFT JOIN platform_connection_versions v
					ON v.connection_id = c.id AND v.id = c.active_version_id
				WHERE c.project_instance_id = $1
				ORDER BY c.kind
			`,
			values: [instanceId],
		});
	}
}
