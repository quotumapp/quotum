import type { MerchantSql } from "../database";
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
export class ConnectionRepository {
	constructor(
		readonly sql: MerchantSql,
		readonly cipher: ConnectionCipher,
	) {}
	async matchesKind(connectionId: string, kind: ConnectionKind) {
		const rows = await this
			.sql`SELECT id FROM platform_connections WHERE id=${connectionId} AND kind=${kind}`;
		return rows.length > 0;
	}
	async recordEvent(version: ConnectionVersion, identity: string, occurred: Date) {
		const rows = await this
			.sql`UPDATE platform_connection_versions SET event_verified_at=now() WHERE id=${version.id} AND connection_id=${version.connection_id} AND (external_identity IS NULL OR external_identity=${identity}) AND created_at<=${occurred} AND (status='active' OR (status IN ('draft','validated') AND expires_at>now())) RETURNING id`;
		return rows.length > 0;
	}
	async active(
		instanceId: string,
		kind: ConnectionKind,
		recovery = false,
	): Promise<{ version: ConnectionVersion; secrets: Record<string, string> } | null> {
		const [version] = await this.sql<
			ConnectionVersion[]
		>`SELECT v.* FROM platform_connections c JOIN platform_connection_versions v ON v.connection_id=c.id AND v.id=c.active_version_id WHERE c.project_instance_id=${instanceId} AND c.kind=${kind} AND (c.enabled OR ${recovery})`;
		if (!version) return null;
		return { version, secrets: await this.secrets(version) };
	}
	async version(instanceId: string, id: string, sql = this.sql): Promise<ConnectionVersion> {
		const [version] = await sql<
			ConnectionVersion[]
		>`SELECT * FROM platform_connection_versions WHERE id=${id} AND project_instance_id=${instanceId}`;
		if (!version)
			throw new MerchantError("CONNECTION_NOT_FOUND", "Connection draft is unavailable.", 404);
		return version;
	}
	async secrets(version: ConnectionVersion): Promise<Record<string, string>> {
		const rows = await this.sql<
			{ purpose: string; envelope: SecretEnvelope }[]
		>`SELECT purpose,envelope FROM platform_connection_secrets WHERE connection_id=${version.connection_id} AND version_id=${version.id}`;
		try {
			const [connection] = await this.sql<
				{ kind: ConnectionKind }[]
			>`SELECT kind FROM platform_connections WHERE id=${version.connection_id}`;
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
		sql: MerchantSql,
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
			await sql`INSERT INTO platform_connection_secrets(connection_id,version_id,purpose,envelope) VALUES(${version.connection_id},${version.id},${purpose},${JSON.stringify(envelope)}::text::jsonb)`;
		}
	}
	async list(instanceId: string) {
		return this.sql<
			{
				id: string;
				kind: ConnectionKind;
				revision: number;
				enabled: boolean;
				active_version_id: string | null;
				settings: Record<string, unknown> | null;
				validated_at: Date | null;
				event_verified_at: Date | null;
			}[]
		>`SELECT c.id,c.kind,c.revision,c.enabled,c.active_version_id,v.settings,v.validated_at,v.event_verified_at FROM platform_connections c LEFT JOIN platform_connection_versions v ON v.connection_id=c.id AND v.id=c.active_version_id WHERE c.project_instance_id=${instanceId} ORDER BY c.kind`;
	}
}
