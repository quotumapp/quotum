import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConnectionsCommand } from "../../../src/composition/cli/connections";
import { runCredentialsCommand } from "../../../src/composition/cli/credentials";
import {
	CliUsageError,
	CommandReport,
	openOperatorContext,
	operatorActor,
	parseArguments,
	readSecrets,
	requestKey,
	reserveSecretFile,
	runOperatorCommand,
} from "../../../src/composition/cli/operator-context";
import { MerchantError } from "../../../src/platform/security";

const noStdin = async () => new Uint8Array();

async function withDirectory(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "quotum-operator-cli-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function captured() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		output: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) },
	};
}

describe("operator command arguments", () => {
	it("parses positionals and valued options strictly", () => {
		expect(
			parseArguments(
				["alpha", "--actor", "ops", "--secrets-file", "-"],
				["actor", "secrets-file"],
				1,
			),
		).toEqual({
			positionals: ["alpha"],
			options: new Map([
				["actor", "ops"],
				["secrets-file", "-"],
			]),
		});
		for (const [args, message] of [
			[["alpha", "--secret", "sk_live"], "Unknown option --secret."],
			[["alpha", "--actor", "a", "--actor", "b"], "--actor is given more than once."],
			[["alpha", "--actor"], "--actor needs a value."],
			[["alpha", "--actor", "--request-key"], "--actor needs a value."],
			[["alpha", "beta"], "Expected 1 argument before the options."],
		] as const)
			expect(() => parseArguments(args, ["actor", "request-key"], 1)).toThrow(message);
	});

	it("names the actor and request key, or refuses", () => {
		expect(operatorActor(new Map([["actor", "ops@example"]]), {})).toBe("ops@example");
		expect(operatorActor(new Map(), { QUOTUM_ACTOR: " deploy-bot " })).toBe("deploy-bot");
		expect(() => operatorActor(new Map(), {})).toThrow(CliUsageError);
		expect(() => operatorActor(new Map([["actor", "two words"]]), {})).toThrow(CliUsageError);
		expect(requestKey(new Map())).toMatch(/^cli-[0-9a-f-]{36}$/);
		expect(requestKey(new Map([["request-key", "retry-0001"]]))).toBe("retry-0001");
		expect(() => requestKey(new Map([["request-key", "short"]]))).toThrow(CliUsageError);
	});
});

describe("operator command secrets", () => {
	it("reads string secrets from a file or stdin and never repeats the input", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "secrets.json");
			await writeFile(path, JSON.stringify({ secretKey: "rk_test_1" }));
			await expect(readSecrets(path, noStdin)).resolves.toEqual({ secretKey: "rk_test_1" });
			await expect(
				readSecrets("-", async () => new TextEncoder().encode('{"webhookSecret":"whsec_1"}')),
			).resolves.toEqual({ webhookSecret: "whsec_1" });

			for (const content of [
				'{"secretKey": "rk_live_leak"',
				'{"secretKey": 42}',
				'["rk_live_leak"]',
			]) {
				await writeFile(path, content);
				const failure = await readSecrets(path, noStdin).catch((error: Error) => error);
				expect(failure).toBeInstanceOf(CliUsageError);
				expect((failure as Error).message).not.toContain("rk_live_leak");
			}
			await writeFile(path, JSON.stringify({ secretKey: "x".repeat(70_000) }));
			await expect(readSecrets(path, noStdin)).rejects.toThrow("is larger than 64 KB.");
		});
	});

	it("reserves a new owner-only file and removes it when discarded", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "secret.json");
			const file = await reserveSecretFile(path);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			await expect(reserveSecretFile(path)).rejects.toThrow();
			await file.write("secret\n");
			expect(await readFile(path, "utf8")).toBe("secret\n");

			const discarded = join(directory, "discarded.json");
			await (await reserveSecretFile(discarded)).discard();
			await expect(stat(discarded)).rejects.toThrow();
		});
	});
});

describe("operator command results", () => {
	it("prints JSON on success and maps failures to exit codes", async () => {
		const ok = captured();
		expect(
			await runOperatorCommand(async () => ({ done: true }), "quotum x --help", ok.output),
		).toBe(0);
		expect(JSON.parse(ok.out.join(""))).toEqual({ done: true });

		const usage = captured();
		expect(
			await runOperatorCommand(
				async () => {
					throw new CliUsageError("Missing subcommand.");
				},
				"quotum x --help",
				usage.output,
			),
		).toBe(64);
		expect(usage.err).toEqual(["Missing subcommand. Run `quotum x --help` for usage."]);

		const refused = captured();
		expect(
			await runOperatorCommand(
				async () => {
					throw new MerchantError("CONNECTION_CHANGED", "Refresh this connection.", 409);
				},
				"quotum x --help",
				refused.output,
			),
		).toBe(1);
		expect(refused.err).toEqual(["CONNECTION_CHANGED: Refresh this connection."]);
	});

	it("lets a report set its exit code and add a note on stderr", async () => {
		const attention = captured();
		expect(
			await runOperatorCommand(
				async () => new CommandReport({ current: false }, 2, "Run the fix."),
				"quotum x --help",
				attention.output,
			),
		).toBe(2);
		expect(JSON.parse(attention.out.join(""))).toEqual({ current: false });
		expect(attention.err).toEqual(["Run the fix."]);

		const quiet = captured();
		expect(
			await runOperatorCommand(
				async () => new CommandReport({ current: true }, 0),
				"quotum x --help",
				quiet.output,
			),
		).toBe(0);
		expect(quiet.err).toEqual([]);
	});

	it("refuses unsafe settings before connecting to the database", async () => {
		const base = {
			POSTGRES_URI: "postgres://quotum@127.0.0.1:9/unused",
			QUOTUM_SECRETS_KEY_ID: "test",
			QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
			QUOTUM_AUTH_SECRET: "operator-cli-test-secret-at-least-32-chars",
		};
		await expect(openOperatorContext({ ...base, POSTGRES_URI: "" })).rejects.toThrow(
			"POSTGRES_URI is required",
		);
		await expect(openOperatorContext({ ...base, QUOTUM_AUTH_SECRET: "short" })).rejects.toThrow(
			"QUOTUM_AUTH_SECRET must be at least 32 characters",
		);
		await expect(
			openOperatorContext({ ...base, BILLING_PROJECTION_ALLOWED_NETWORKS: "10.20.0.0/16" }),
		).rejects.toThrow("require QUOTUM_MERCHANT_ENABLED=false");
		await expect(
			openOperatorContext({ ...base, BILLING_POSTGRES_PREPARED_STATEMENTS: "no" }),
		).rejects.toThrow("BILLING_POSTGRES_PREPARED_STATEMENTS");
	});

	it("rejects wrong command arguments with exit 64", async () => {
		await withDirectory(async (directory) => {
			const settings = join(directory, "settings.json");
			await writeFile(settings, "{}");
			for (const argv of [
				[],
				["bogus"],
				["draft", "alpha-sandbox", "projection", "--settings", settings, "--actor", "ops"],
				["draft", "alpha-sandbox", "stripe", "--settings", settings, "--secret", "rk_live_x"],
				["draft", "alpha-sandbox", "ledger", "--settings", settings],
				["commit", "alpha-sandbox", "stripe", "draft-id", "--wait-for-event", "2h"],
				["disable", "alpha-sandbox", "stripe", "--actor", "ops"],
			]) {
				const { output, err } = captured();
				expect(await runConnectionsCommand(argv, {}, { output, stdin: noStdin })).toBe(64);
				expect(err.join("")).not.toContain("rk_live_x");
			}
			for (const argv of [
				[
					"rotate",
					"alpha-sandbox",
					"--credentials-out",
					join(directory, "c.json"),
					"--actor",
					"ops",
				],
				["revoke", "alpha-sandbox", "--access", "full", "--actor", "ops"],
				["status"],
			])
				expect(await runCredentialsCommand(argv, {}, { output: captured().output })).toBe(64);
		});
	});
});
