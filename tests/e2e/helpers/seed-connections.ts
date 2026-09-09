import { SQL } from "bun";
import { merchantSql } from "../../../src/composition/merchant-persistence";
import { loadConnectionCipher } from "../../../src/platform/connections/cipher";
import { ConnectionRepository } from "../../../src/platform/connections/repository";
import type { ProjectConnectionFixture } from "../../../src/testing/connection-fixtures";
/** Test infrastructure seeds encrypted records; the service still resolves them from Postgres. */
export async function seedProcessConnections(env: NodeJS.ProcessEnv) {
	if (env.BILLING_ENV !== "test") throw new Error("Test connection seeding requires test mode");
	const fixtures = JSON.parse(
		env.BILLING_TEST_CONNECTIONS_JSON ?? "[]",
	) as ProjectConnectionFixture[];
	if (!fixtures.length) return;
	const client = new SQL(env.POSTGRES_URI ?? "", { max: 1 });
	const sql = merchantSql(client);
	const cipher = loadConnectionCipher(env);
	try {
		for (const fixture of fixtures)
			await sql.begin(async (tx) => {
				const rows = await tx<
					{ id: string }[]
				>`SELECT id FROM projects WHERE key=${fixture.projectInstanceKey}`;
				const instance = rows[0];
				if (!instance) return;
				const configs = {
					projection: {
						projectionUrl: fixture.projectionUrl,
						projectionSecret: fixture.projectionSecret,
					},
					stripe: fixture.stripe,
				};
				for (const kind of ["projection", "stripe"] as const) {
					const config = configs[kind];
					if (!config) continue;
					await tx`INSERT INTO platform_connections(project_instance_id,kind) VALUES(${instance.id},${kind}) ON CONFLICT(project_instance_id,kind) DO NOTHING`;
					const [connection] = await tx<
						{ id: string; revision: number }[]
					>`SELECT id,revision FROM platform_connections WHERE project_instance_id=${instance.id} AND kind=${kind} FOR UPDATE`;
					if (!connection) throw new Error("Missing fixture connection");
					const id = crypto.randomUUID();
					const settings: Record<string, unknown> = {},
						secrets: Record<string, string> = {};
					for (const [key, value] of Object.entries(config)) {
						if (["secretKey", "webhookSecret", "projectionSecret"].includes(key))
							secrets[key] = String(value);
						else settings[key] = value;
					}
					await tx`INSERT INTO platform_connection_versions(id,connection_id,project_instance_id,expected_revision,settings,status,request_key,request_fingerprint) VALUES(${id},${connection.id},${instance.id},${connection.revision},${JSON.stringify(settings)}::text::jsonb,'active',${id},'test-fixture')`;
					await new ConnectionRepository(tx, cipher).saveSecrets(
						tx,
						{ id, connection_id: connection.id, project_instance_id: instance.id },
						secrets,
					);
					await tx`UPDATE platform_connections SET active_version_id=${id},enabled=true,revision=revision+1 WHERE id=${connection.id}`;
				}
			});
	} finally {
		await client.close();
	}
}
