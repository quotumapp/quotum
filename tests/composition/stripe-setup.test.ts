import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
	readSetupCredentials,
	runStripeSetupCommand,
} from "../../src/composition/cli/stripe-setup";
import { createOperatorMcpServer } from "../../src/composition/operator-mcp/server";
import { inspectBinding } from "../../src/composition/stripe-setup/provider";
import { stripeSetupManifestSchema } from "../../src/composition/stripe-setup/schema";
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
});
