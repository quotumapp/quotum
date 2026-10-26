import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { runConnectionsCommand } from "../../src/composition/cli/connections";
import { createOperatorCommandRunner } from "../../src/composition/operator-mcp/command";
import { toolJson, toolText } from "../../tests/helpers/mcp";
import {
	connectOperatorMcp,
	operatorTestCatalog,
	operatorTestManifest,
} from "../../tests/helpers/operator-mcp";
import { merchantFixture, stubConnectionValidation } from "./fixture";
import { operatorEnv, withScratchDirectory } from "./operator-fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

describe("local operator MCP setup", () => {
	it("bootstraps, configures a connection, issues a key and publishes a catalog without merchant auth", async () => {
		await withScratchDirectory(async (directory) => {
			const env = { ...createSanitizedProcessEnv(), ...operatorEnv };
			const runner = createOperatorCommandRunner(env);
			const connection = await connectOperatorMcp({
				version: "test",
				actor: "mcp-setup-operator",
				directory,
				env,
				run: async (command) => {
					if (
						command.args[0] !== "connections" ||
						!["validate", "commit"].includes(command.args[1] ?? "")
					)
						return runner.run(command);
					// Only external receiver I/O is faked; authorization and persistence use Postgres.
					const stdout: string[] = [];
					const stderr: string[] = [];
					const exitCode = await runConnectionsCommand(command.args.slice(1), env, {
						validator: stubConnectionValidation(),
						output: {
							stdout: (value) => stdout.push(value),
							stderr: (value) => stderr.push(value),
						},
					});
					return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
				},
			});
			const results: string[] = [];
			const call = async (name: string, args: Record<string, unknown>) => {
				const result = await connection.client.callTool({ name, arguments: args });
				results.push(toolText(result));
				expect([name, result.isError, result.isError ? toolText(result) : ""]).toEqual([
					name,
					undefined,
					"",
				]);
				return toolJson(result) as { exitCode: number; data: Record<string, unknown> };
			};
			try {
				const migrations = await call("migrate_database", {});
				expect(migrations.data.migrations).toBeArray();
				const inspection = await call("inspect_bootstrap", { manifest: operatorTestManifest });
				expect(inspection.exitCode).toBe(2);
				await call("apply_bootstrap", {
					manifest: operatorTestManifest,
					credentialsOut: "bootstrap.json",
				});
				const bootstrapFile = join(directory, "bootstrap.json");
				const bootstrapKeys = JSON.parse(await readFile(bootstrapFile, "utf8"));
				expect(bootstrapKeys.credentials[0].credential).toStartWith("sqpk_");
				expect((await stat(bootstrapFile)).mode & 0o777).toBe(0o600);
				expect((await call("inspect_bootstrap", { manifest: operatorTestManifest })).exitCode).toBe(
					0,
				);

				await call("get_credentials", { instance: "mcp-sandbox" });
				await call("rotate_credentials", {
					instance: "mcp-sandbox",
					access: "read_only",
					credentialsOut: "readonly.json",
					requestKey: "mcp-readonly-key",
				});
				const readonlyFile = join(directory, "readonly.json");
				const readonlyKeys = JSON.parse(await readFile(readonlyFile, "utf8"));
				expect(readonlyKeys.readOnlyCredentials[0].credential).toStartWith("sqrk_");
				expect((await stat(readonlyFile)).mode & 0o777).toBe(0o600);
				const replay = await call("rotate_credentials", {
					instance: "mcp-sandbox",
					access: "read_only",
					credentialsOut: "replay.json",
					requestKey: "mcp-readonly-key",
				});
				expect(replay.data).toMatchObject({ credentialDisclosed: false, credentialsOut: null });

				const draft = await call("draft_connection", {
					instance: "mcp-sandbox",
					kind: "projection",
					settings: { projectionUrl: "https://backend.example.com" },
					expectedRevision: 0,
					secretOut: "receiver.json",
					requestKey: "mcp-projection-draft",
				});
				const receiver = JSON.parse(await readFile(join(directory, "receiver.json"), "utf8"));
				const target = { instance: "mcp-sandbox", kind: "projection", draftId: draft.data.draftId };
				await call("validate_connection", target);
				await call("commit_connection", { ...target, requestKey: "mcp-projection-commit" });
				const connections = await call("list_connections", { instance: "mcp-sandbox" });
				expect(connections.data.connections).toMatchObject([
					{ kind: "projection", enabled: true, revision: 1 },
				]);

				const catalog = {
					instance: "mcp-sandbox",
					catalog: operatorTestCatalog,
					expectedRevision: null,
				};
				await call("preview_catalog", catalog);
				await call("publish_catalog", catalog);
				const published = await call("get_catalog", { instance: "mcp-sandbox" });
				expect(published.data.revision).toBe(1);
				const stale = await connection.client.callTool({
					name: "publish_catalog",
					arguments: catalog,
				});
				expect(stale.isError).toBe(true);
				await call("get_environment_readiness", { instance: "mcp-sandbox" });
				const audit = await f.sql<
					{ operator: string }[]
				>`SELECT metadata->>'operator' AS operator FROM platform_audit_events WHERE metadata->>'operator' IS NOT NULL`;
				expect(audit.length).toBeGreaterThan(0);
				expect(audit.every((row) => row.operator === "mcp-setup-operator")).toBe(true);
				for (const secret of [
					bootstrapKeys.credentials[0].credential,
					readonlyKeys.readOnlyCredentials[0].credential,
					receiver.projectionSecret,
					env.QUOTUM_AUTH_SECRET,
					env.QUOTUM_SECRETS_KEY_BASE64,
				])
					expect(results.join("\n")).not.toContain(secret);
			} finally {
				await connection.close();
				runner.close();
			}
		});
	}, 30_000);
});
