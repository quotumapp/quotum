import type { MerchantSql } from "../database";
import type { ConnectionCipher, SecretEnvelope } from "./cipher";

/** One short, restartable batch. Concurrent rotators skip locked rows; plaintext never leaves memory. */
export async function rotateConnectionSecrets(
	sql: MerchantSql,
	cipher: ConnectionCipher,
	limit = 100,
): Promise<number> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
		throw new Error("Rotation batch size must be between 1 and 1000");
	return sql.begin(async (tx) => {
		const rows = await tx<
			{
				connection_id: string;
				version_id: string;
				project_instance_id: string;
				purpose: string;
				envelope: SecretEnvelope;
			}[]
		>`SELECT s.connection_id,s.version_id,v.project_instance_id,s.purpose,s.envelope FROM platform_connection_secrets s JOIN platform_connection_versions v ON v.id=s.version_id AND v.connection_id=s.connection_id WHERE s.envelope->>'keyId' <> ${cipher.activeKeyId} ORDER BY s.connection_id,s.version_id,s.purpose LIMIT ${limit} FOR UPDATE OF s SKIP LOCKED`;
		for (const row of rows) {
			const scope = {
				instanceId: row.project_instance_id,
				connectionId: row.connection_id,
				versionId: row.version_id,
				purpose: row.purpose,
			};
			const envelope = cipher.encrypt(cipher.decrypt(row.envelope, scope), scope);
			await tx`UPDATE platform_connection_secrets SET envelope=${JSON.stringify(envelope)}::text::jsonb WHERE connection_id=${row.connection_id} AND version_id=${row.version_id} AND purpose=${row.purpose}`;
		}
		return rows.length;
	});
}
