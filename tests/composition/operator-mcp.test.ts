import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv/dist/2020";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import {
	createOperatorCommandRunner,
	type OperatorCommand,
	operatorFile,
	operatorResult,
} from "../../src/composition/operator-mcp/command";
import { toolJson, toolText } from "../helpers/mcp";
import {
	connectOperatorMcp,
	operatorTestCatalog,
	operatorTestManifest,
} from "../helpers/operator-mcp";

const env = {
	POSTGRES_URI: "postgres://local/quotum",
	QUOTUM_AUTH_SECRET: "secret-auth-value",
	QUOTUM_SECRETS_KEY_ID: "key",
	QUOTUM_SECRETS_KEY_BASE64: "secret-key-value",
};
let connection: Awaited<ReturnType<typeof connectOperatorMcp>> | undefined;
const directories: string[] = [];
afterEach(async () => {
	await connection?.close();
	connection = undefined;
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function scratch() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "operator-mcp-test-")));
	directories.push(directory);
	return directory;
}
async function connect(overrides: Partial<Parameters<typeof connectOperatorMcp>[0]> = {}) {
	const commands: OperatorCommand[] = [];
	connection = await connectOperatorMcp({
		version: "test",
		actor: "host-operator",
		directory: await scratch(),
		env,
		run: async (command) => {
			commands.push(command);
			return { exitCode: 0, stdout: "{}", stderr: "" };
		},
		...overrides,
	});
	return { client: connection.client, commands };
}

describe("local operator MCP", () => {
	it("advertises valid typed setup tools separately from billing reads and proposals", async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[
				"get_setup_status",
				"migrate_database",
				"inspect_bootstrap",
				"apply_bootstrap",
				"get_environment_readiness",
				"list_connections",
				"draft_connection",
				"validate_connection",
				"commit_connection",
				"get_credentials",
				"rotate_credentials",
				"get_catalog",
				"preview_catalog",
				"publish_catalog",
				"list_catalog_bindings",
				"adopt_catalog_bindings",
			].sort(),
		);
		const ajv = new Ajv({ strict: false });
		for (const tool of tools)
			expect([tool.name, ajv.validateSchema(tool.inputSchema)]).toEqual([tool.name, true]);
		expect(tools.find((tool) => tool.name === "preview_catalog")?.annotations?.readOnlyHint).toBe(
			false,
		);
		expect(tools.find((tool) => tool.name === "get_catalog")?.annotations?.readOnlyHint).toBe(true);
	});

	it("reports missing settings without returning values or starting a command", async () => {
		const { client, commands } = await connect({ env: { QUOTUM_AUTH_SECRET: "never-disclose" } });
		const status = await client.callTool({ name: "get_setup_status", arguments: {} });
		expect(toolJson(status)).toMatchObject({
			missingSettings: ["POSTGRES_URI", "QUOTUM_SECRETS_KEY_ID", "QUOTUM_SECRETS_KEY_BASE64"],
		});
		expect(toolText(status)).not.toContain("never-disclose");
		expect(
			await client.callTool({ name: "list_connections", arguments: { instance: "alpha" } }),
		).toMatchObject({ isError: true });
		expect(commands).toEqual([]);
	});

	it("uses fixed commands, explicit targets and the host's audit actor", async () => {
		const directory = await scratch();
		await writeFile(
			join(directory, "stripe.json"),
			JSON.stringify({ secretKey: "private-provider-key" }),
		);
		const { client, commands } = await connect({ directory });
		const cases = [
			["migrate_database", {}, ["migrate", "status"]],
			["migrate_database", { apply: true }, ["migrate"]],
			["inspect_bootstrap", { manifest: operatorTestManifest }, ["bootstrap", "--check"]],
			[
				"apply_bootstrap",
				{ manifest: operatorTestManifest, credentialsOut: "keys.json" },
				["bootstrap", "--apply", "--credentials-out", join(directory, "keys.json")],
			],
			["get_environment_readiness", { instance: "alpha" }, ["environments", "readiness", "alpha"]],
			["list_connections", { instance: "alpha" }, ["connections", "list", "alpha"]],
			[
				"draft_connection",
				{
					instance: "alpha",
					kind: "stripe",
					settings: {},
					secretsFile: "stripe.json",
					expectedRevision: 0,
					requestKey: "draft-key-1",
				},
				[
					"connections",
					"draft",
					"alpha",
					"stripe",
					"--settings",
					"<input>",
					"--expected-revision",
					"0",
					"--request-key",
					"draft-key-1",
					"--actor",
					"host-operator",
					"--secrets-file",
					join(directory, "stripe.json"),
				],
			],
			[
				"draft_connection",
				{
					instance: "alpha",
					kind: "projection",
					settings: { projectionUrl: "https://example.com" },
					secretOut: "receiver.json",
					expectedRevision: 0,
					requestKey: "draft-key-2",
				},
				[
					"connections",
					"draft",
					"alpha",
					"projection",
					"--settings",
					"<input>",
					"--expected-revision",
					"0",
					"--request-key",
					"draft-key-2",
					"--actor",
					"host-operator",
					"--secret-out",
					join(directory, "receiver.json"),
				],
			],
			[
				"validate_connection",
				{ instance: "alpha", kind: "stripe", draftId: "01900000-0000-7000-8000-000000000001" },
				[
					"connections",
					"validate",
					"alpha",
					"stripe",
					"01900000-0000-7000-8000-000000000001",
					"--actor",
					"host-operator",
				],
			],
			[
				"commit_connection",
				{
					instance: "alpha",
					kind: "stripe",
					draftId: "01900000-0000-7000-8000-000000000001",
					requestKey: "commit-key-1",
					memberOverrideReason: "Owner requested setup",
				},
				[
					"connections",
					"commit",
					"alpha",
					"stripe",
					"01900000-0000-7000-8000-000000000001",
					"--request-key",
					"commit-key-1",
					"--actor",
					"host-operator",
					"--member-override-reason",
					"Owner requested setup",
				],
			],
			["get_credentials", { instance: "alpha" }, ["credentials", "status", "alpha"]],
			[
				"rotate_credentials",
				{
					instance: "alpha",
					access: "read_only",
					credentialsOut: "read.json",
					requestKey: "rotate-key-1",
				},
				[
					"credentials",
					"rotate",
					"alpha",
					"--access",
					"read_only",
					"--credentials-out",
					join(directory, "read.json"),
					"--request-key",
					"rotate-key-1",
					"--actor",
					"host-operator",
				],
			],
			["get_catalog", { instance: "alpha" }, ["catalog", "status", "--instance", "alpha"]],
			[
				"preview_catalog",
				{ instance: "alpha", catalog: operatorTestCatalog, expectedRevision: null },
				["catalog", "diff", "<input>", "--instance", "alpha", "--actor", "host-operator"],
			],
			[
				"publish_catalog",
				{ instance: "alpha", catalog: operatorTestCatalog, expectedRevision: 1 },
				["catalog", "push", "<input>", "--instance", "alpha", "--actor", "host-operator"],
			],
			[
				"list_catalog_bindings",
				{ instance: "alpha" },
				["catalog", "bindings", "list", "--instance", "alpha"],
			],
			[
				"adopt_catalog_bindings",
				{
					instance: "alpha",
					binding: {
						provider: "stripe",
						productKey: "gift",
						name: "Gift",
						kind: "gift",
						externalProductId: "prod_gift",
						externalPriceId: "price_gift",
					},
				},
				[
					"catalog",
					"bindings",
					"adopt",
					"<input>",
					"--instance",
					"alpha",
					"--actor",
					"host-operator",
				],
			],
		] as const;
		for (const [name, args, expected] of cases) {
			const result = await client.callTool({ name, arguments: args });
			expect(result.isError).toBeUndefined();
			expect(commands.at(-1)?.args).toEqual([...expected]);
			expect(toolText(result)).not.toContain("private-provider-key");
		}
		expect(commands.find((command) => command.args[0] === "bootstrap")?.env).toEqual({
			BILLING_PLATFORM_BOOTSTRAP_JSON: JSON.stringify(operatorTestManifest),
		});
		expect(commands.find((command) => command.args[1] === "push")?.input).toMatchObject({
			expectedRevision: 1,
			catalog: operatorTestCatalog,
		});
	});

	it("rejects path escapes, actor spoofing and implicit catalog revisions before dispatch", async () => {
		const { client, commands } = await connect();
		for (const args of [
			{
				instance: "alpha",
				access: "full",
				credentialsOut: "../escape.json",
				requestKey: "request-key",
			},
			{
				instance: "alpha",
				access: "full",
				credentialsOut: "/absolute.json",
				requestKey: "request-key",
			},
			{
				instance: "--help",
				access: "full",
				credentialsOut: "keys.json",
				requestKey: "request-key",
			},
			{
				instance: "alpha",
				access: "full",
				credentialsOut: "keys.json",
				requestKey: "request-key",
				actor: "spoofed",
			},
		])
			expect(await client.callTool({ name: "rotate_credentials", arguments: args })).toMatchObject({
				isError: true,
			});
		expect(
			await client.callTool({
				name: "publish_catalog",
				arguments: { instance: "alpha", catalog: operatorTestCatalog },
			}),
		).toMatchObject({ isError: true });
		expect(commands).toEqual([]);
	});

	it("refuses option-looking values and oversized input before a CLI can misread them", async () => {
		const { client, commands } = await connect();
		for (const extra of [{ memberOverrideReason: "--help" }, { requestKey: "--request-key" }]) {
			expect(
				await client.callTool({
					name: "rotate_credentials",
					arguments: {
						instance: "alpha",
						access: "full",
						credentialsOut: "keys.json",
						requestKey: "valid-request",
						...extra,
					},
				}),
			).toMatchObject({ isError: true });
		}
		const oversized = await client.callTool({
			name: "draft_connection",
			arguments: {
				instance: "alpha",
				kind: "stripe",
				settings: { large: "x".repeat(256 * 1024) },
				expectedRevision: 0,
				requestKey: "valid-request",
			},
		});
		expect(oversized).toMatchObject({ isError: true });
		expect(toolText(oversized)).toContain("256 KB");
		expect(commands).toEqual([]);
	});

	it("refuses symlink and malformed secrets inputs without echoing their contents", async () => {
		const directory = await scratch();
		const outside = await scratch();
		await writeFile(join(outside, "secrets.json"), '{"key":"secret-value"}');
		await symlink(join(outside, "secrets.json"), join(directory, "linked.json"));
		await writeFile(join(directory, "invalid.json"), "private-content-not-json");
		await expect(operatorFile(directory, "../escape", true)).rejects.toThrow();
		await expect(operatorFile(directory, "linked.json", true)).rejects.toThrow();
		const { client, commands } = await connect({ directory });
		const result = await client.callTool({
			name: "draft_connection",
			arguments: {
				instance: "alpha",
				kind: "stripe",
				settings: {},
				secretsFile: "invalid.json",
				expectedRevision: 0,
				requestKey: "request-key",
			},
		});
		expect(result).toMatchObject({ isError: true });
		expect(toolText(result)).not.toContain("private-content");
		expect(commands).toEqual([]);
	});

	it("does not run concurrent commands or leak exceptions", async () => {
		let finish: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const { client } = await connect({
			run: async () => {
				entered();
				await waiting;
				throw new Error("secret-database-password");
			},
		});
		const first = client.callTool({ name: "get_catalog", arguments: { instance: "alpha" } });
		await started;
		expect(
			toolText(await client.callTool({ name: "get_catalog", arguments: { instance: "alpha" } })),
		).toContain("Another setup command");
		finish();
		const result = await first;
		expect(result).toMatchObject({ isError: true });
		expect(toolText(result)).not.toContain("secret-database-password");
	});
});

describe("operator command transport", () => {
	it("preserves informational findings, bounds results and hides raw diagnostics", () => {
		expect(
			toolJson(operatorResult({ exitCode: 2, stdout: '{"ready":false}', stderr: "" })),
		).toEqual({ exitCode: 2, data: { ready: false } });
		const failed = operatorResult({
			exitCode: 1,
			stdout: "secret",
			stderr: "PROVIDER_EVENT_REQUIRED: secret",
		});
		expect(failed.isError).toBe(true);
		expect(toolJson(failed)).toMatchObject({ error: "PROVIDER_EVENT_REQUIRED" });
		expect(toolText(failed)).not.toContain("secret");
		expect(
			toolJson(
				operatorResult({
					exitCode: 0,
					stdout: JSON.stringify({ large: "x".repeat(100_000) }),
					stderr: "",
				}),
			),
		).toMatchObject({ completed: true, resultOmitted: expect.any(String) });
		expect(
			toolJson(
				operatorResult({
					exitCode: 0,
					stdout: "applied 001_platform.sql\npending 002_billing.sql\n",
					stderr: "",
				}),
			),
		).toMatchObject({
			data: {
				migrations: [
					{ status: "applied", file: "001_platform.sql" },
					{ status: "pending", file: "002_billing.sql" },
				],
			},
		});
	});

	it("passes JSON data to the real CLI without evaluating it as source", async () => {
		const runner = createOperatorCommandRunner(createSanitizedProcessEnv());
		try {
			const result = await runner.run({
				args: ["catalog", "format", "<input>"],
				input: { catalog: operatorTestCatalog, expectedRevision: null },
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('"credits"');
			expect(result.stderr).toBe("");
		} finally {
			runner.close();
		}
		await expect(runner.run({ args: ["version"] })).rejects.toThrow("closed");
	});
});
