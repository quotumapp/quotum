import { describe, expect, it, spyOn } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CliUsageError } from "../../src/composition/cli/operator-context";
import {
	readSetupCredentials,
	runStripeSetupCommand,
} from "../../src/composition/cli/stripe-setup";
import { createOperatorMcpServer } from "../../src/composition/operator-mcp/server";
import { inspectBinding } from "../../src/composition/stripe-setup/provider";
import { SetupFailure, stripeSetupManifestSchema } from "../../src/composition/stripe-setup/schema";
import { StripeSetupService } from "../../src/composition/stripe-setup/service";
import { MerchantError } from "../../src/platform/security";
import { SetupStripeTransport, setupManifest } from "../helpers/stripe-setup";

async function scratch(work: (directory: string) => Promise<void>) {
	const path = await mkdtemp(join(tmpdir(), "quotum-setup-"));
	try {
		await work(await realpath(path));
	} finally {
		await rm(path, { recursive: true, force: true });
	}
}

describe("Stripe setup inputs and local tools", () => {
	it("requires explicit operator startup authority and drains cleanly when stdin closes", async () => {
		await scratch(async (directory) => {
			const run = async (args: string[]) => {
				const child = Bun.spawn(
					[process.execPath, "--no-env-file", "src/composition/operator-mcp/index.ts", ...args],
					{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} },
				);
				child.stdin.end();
				const [code, out, err] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { code, out, err };
			};
			expect((await run(["--actor", "ops", "--directory", directory])).code).toBe(1);
			expect((await run(["--allow-writes", "--directory", directory])).code).toBe(1);
			expect((await run(["--allow-writes", "--actor", "ops"])).code).toBe(1);
			await chmod(directory, 0o755);
			expect((await run(["--allow-writes", "--actor", "ops", "--directory", directory])).code).toBe(
				1,
			);
			await chmod(directory, 0o700);
			expect(await run(["--allow-writes", "--actor", "ops", "--directory", directory])).toEqual({
				code: 0,
				out: "",
				err: "",
			});
		});
	});
	it("rejects malformed intent, duplicate bindings and credential placement", () => {
		const input = setupManifest();
		expect(stripeSetupManifestSchema.safeParse(input).success).toBe(true);
		for (const changed of [
			{ publicOrigin: "http://billing.example.com" },
			{ publicOrigin: "https://billing.example.com/path" },
			{ bindings: [...input.bindings, ...input.bindings] },
			{ setupKey: "rk_test_never_persist" },
			{ settings: { ...input.settings, secretKey: "rk_test_never_persist" } },
			{ bindings: [{ ...input.bindings[0], kind: "subscription" }] },
		])
			expect(stripeSetupManifestSchema.safeParse({ ...input, ...changed }).success).toBe(false);
	});
	it("reads private credentials without following symlinks or disclosing invalid input", async () => {
		await scratch(async (directory) => {
			const path = join(directory, "credentials.json");
			const credentials = new SetupStripeTransport().credentials();
			await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
			expect(await readSetupCredentials(path)).toEqual(credentials);
			await symlink(path, join(directory, "link.json"));
			await expect(readSetupCredentials(join(directory, "link.json"))).rejects.toThrow(
				"private regular JSON",
			);
			await chmod(path, 0o644);
			await expect(readSetupCredentials(path)).rejects.toThrow("private regular JSON");
			await chmod(path, 0o600);
			await writeFile(path, "rk_test_private_value");
			const error = await readSetupCredentials(path).catch((value: Error) => value);
			expect(String(error)).not.toContain("rk_test_private_value");
			await writeFile(path, "x".repeat(65537));
			await expect(readSetupCredentials(path)).rejects.toThrow("64 KB");
		});
	});
	it("refuses price/account-mode mismatches before adoption", async () => {
		const stripe = new SetupStripeTransport();
		const client = stripe.client("rk_test_setup");
		const product = await client.products.create({ name: "Credits" });
		const price = await client.prices.create({
			product: product.id,
			currency: "usd",
			unit_amount: 1000,
			tax_behavior: "unspecified",
		});
		const binding = stripeSetupManifestSchema.parse(setupManifest()).bindings[0];
		if (!binding) throw new Error("Binding missing");
		expect(
			await inspectBinding(client, binding, false, { product: product.id, price: price.id }),
		).toEqual({ product: product.id, price: price.id });
		await expect(
			inspectBinding(client, binding, true, { product: product.id, price: price.id }),
		).rejects.toThrow("environment_mismatch");
		const stored = stripe.objects.get(price.id);
		if (!stored) throw new Error("Missing test price");
		stored.unit_amount = 2000;
		await expect(
			inspectBinding(client, binding, false, { product: product.id, price: price.id }),
		).rejects.toThrow("created_price_changed");
	});
	it("exposes only typed setup tools with fixed actor, bounded host files and no secret arguments", async () => {
		await scratch(async (directory) => {
			await writeFile(join(directory, "manifest.json"), JSON.stringify(setupManifest()));
			await writeFile(join(directory, "credentials.json"), "{}", { mode: 0o600 });
			await symlink(join(directory, "manifest.json"), join(directory, "link.json"));
			const calls: string[][] = [];
			const server = createOperatorMcpServer({
				directory,
				actor: "host-operator",
				env: {},
				run: async (args, _env, dependencies) => {
					calls.push([...args]);
					dependencies?.output?.stdout(JSON.stringify({ status: "prepared" }));
					return 0;
				},
			});
			const client = new Client({ name: "setup-tests", version: "1" });
			const [a, b] = InMemoryTransport.createLinkedPair();
			await server.connect(a);
			await client.connect(b);
			try {
				expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
					"apply_stripe_setup",
					"get_stripe_setup",
					"prepare_stripe_setup",
					"verify_stripe_setup",
				]);
				const call = (args: Record<string, unknown>) =>
					client.callTool({ name: "prepare_stripe_setup", arguments: args });
				expect(
					(await call({ manifestFile: "manifest.json", credentialsFile: "credentials.json" }))
						.isError,
				).toBe(false);
				expect(calls[0]).toContain("host-operator");
				for (const manifestFile of ["../manifest.json", "/tmp/manifest.json", "link.json"])
					expect((await call({ manifestFile, credentialsFile: "credentials.json" })).isError).toBe(
						true,
					);
				expect(
					(await call({ manifestFile: "manifest.json", setupKey: "rk_test_secret" })).isError,
				).toBe(true);
				expect(calls).toHaveLength(1);
			} finally {
				await client.close();
				await server.close();
			}
		});
	});
	it("validates CLI arguments before opening a database", async () => {
		const errors: string[] = [];
		const output = { stdout: () => {}, stderr: (value: string) => errors.push(value) };
		expect(await runStripeSetupCommand(["apply", "not-a-uuid"], {}, { output })).toBe(64);
		expect(errors.join(" ")).toContain("setup UUID");
	});
	it("reports missing encryption configuration as an operational failure", async () => {
		const errors: string[] = [];
		const code = await runStripeSetupCommand(
			["status", "00000000-0000-4000-8000-000000000001"],
			{},
			{ output: { stdout: () => {}, stderr: (value) => errors.push(value) } },
		);
		expect(code).toBe(1);
		expect(errors.join(" ")).toContain("QUOTUM_SECRETS_KEY_ID");
		expect(errors.join(" ")).not.toContain("for usage");
	});
	it.each([
		{ error: new CliUsageError("Invalid input."), code: 64, message: "Invalid input." },
		{ error: new SetupFailure("setup_busy"), code: 1, message: "setup_busy" },
		{
			error: new MerchantError("CONNECTION_CHANGED", "Private provider message", 409),
			code: 64,
			message: "CONNECTION_CHANGED",
		},
		{
			error: new Error("Private provider message"),
			code: 1,
			message: "Stripe setup failed. Check the manifest",
		},
	])("returns $code with safe diagnostics: $message", async ({ error, code, message }) => {
		const status = spyOn(StripeSetupService.prototype, "status").mockRejectedValue(error);
		const out: string[] = [],
			err: string[] = [];
		try {
			expect(
				await runStripeSetupCommand(
					["status", "00000000-0000-4000-8000-000000000001"],
					{
						POSTGRES_URI: "postgres://unused:unused@127.0.0.1:1/unused",
						QUOTUM_AUTH_SECRET: "test-auth-secret-for-stripe-setup-cli",
						QUOTUM_SECRETS_KEY_ID: "test",
						QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
					},
					{ output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) } },
				),
			).toBe(code);
			expect(status).toHaveBeenCalledTimes(1);
			expect(out).toEqual([]);
			expect(err.join(" ")).toContain(message);
			expect(err.join(" ")).not.toContain("Private provider message");
			expect(err.join(" ").includes("for usage")).toBe(code === 64);
		} finally {
			status.mockRestore();
		}
	});
	it.each([
		{
			code: 1,
			out: [],
			err: ["setup_busy", "Inspect status."],
			text: "setup_busy\nInspect status.",
		},
		{ code: 64, out: [], err: ["Invalid input."], text: "Invalid input." },
		{ code: 0, out: ["prepared"], err: ["notice"], text: "prepared" },
		{ code: 2, out: ["pending", "receipt"], err: ["notice"], text: "pending\nreceipt" },
		{ code: 1, out: ["receipt"], err: ["failure"], text: "receipt" },
		{
			code: 1,
			out: [],
			err: [" ", "\n"],
			text: "Setup command failed; check private files, configuration and permissions. Inspect status before retrying.",
		},
		{
			code: 1,
			out: [],
			err: [],
			text: "Setup command failed; check private files, configuration and permissions. Inspect status before retrying.",
		},
		{
			code: 1,
			out: [],
			err: ["界".repeat(20 * 1024), "must not fit"],
			text: "界".repeat(16 * 1024),
		},
	])("preserves MCP output and bounds diagnostics (case %#)", async ({ code, out, err, text }) => {
		await scratch(async (directory) => {
			const server = createOperatorMcpServer({
				directory,
				actor: "host-operator",
				env: {},
				run: async (_args, _env, dependencies) => {
					for (const value of out) dependencies?.output?.stdout(value);
					for (const value of err) dependencies?.output?.stderr(value);
					return code;
				},
			});
			const client = new Client({ name: "setup-tests", version: "1" });
			const [a, b] = InMemoryTransport.createLinkedPair();
			await server.connect(a);
			await client.connect(b);
			try {
				const result = await client.callTool({
					name: "get_stripe_setup",
					arguments: { setupId: "00000000-0000-4000-8000-000000000001" },
				});
				expect(result.isError).toBe(code !== 0 && code !== 2);
				expect(result.content).toEqual([{ type: "text", text }]);
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
			} finally {
				await client.close();
				await server.close();
			}
		});
	});
});
