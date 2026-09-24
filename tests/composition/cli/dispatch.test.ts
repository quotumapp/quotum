import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type QuotumChildProcess,
	type QuotumCliDependencies,
	quotumCommands,
	quotumHelp,
	resolveQuotumCommand,
	runQuotumCli,
} from "../../../src/composition/cli/dispatch";

const sourceRoot = join(import.meta.dir, "../../../src");

function recorder(overrides: Partial<QuotumCliDependencies> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const spawned: string[][] = [];
	return {
		stdout,
		stderr,
		spawned,
		dependencies: {
			env: {},
			stdout: (line: string) => stdout.push(line),
			stderr: (line: string) => stderr.push(line),
			spawn: (cmd: string[]) => {
				spawned.push(cmd);
				return { exited: Promise.resolve(0), kill: () => undefined };
			},
			...overrides,
		} satisfies Partial<QuotumCliDependencies>,
	};
}

describe("quotum command resolution", () => {
	it("points every command at a file that ships in src/", () => {
		for (const command of quotumCommands) {
			expect(existsSync(join(sourceRoot, command.file))).toBe(true);
		}
	});

	it.each([
		[["migrate"], "migrate.ts", []],
		[["migrate", "status"], "migrate.ts", ["status"]],
		[["bootstrap", "--check"], "platform-bootstrap.ts", ["--check"]],
		[["catalog", "provision"], "composition/cli/catalog-provision.ts", []],
		[["catalog", "push", "catalog.ts"], "composition/cli/catalog.ts", ["push", "catalog.ts"]],
		[["catalog", "status"], "composition/cli/catalog.ts", ["status"]],
		[["connections", "rotate-secrets"], "composition/cli/connections-rotate-secrets.ts", []],
		[
			["merchant", "service-principal", "ui-proxy"],
			"composition/cli/merchant-service-principal.ts",
			["ui-proxy"],
		],
		[["mcp"], "mcp/index.ts", []],
	] as const)("resolves %j to %s", (argv, file, args) => {
		const resolution = resolveQuotumCommand(argv);
		expect(resolution).toMatchObject({ kind: "command", command: { file }, args });
	});

	it("treats help as success and a missing or unknown command as a usage error", () => {
		expect(resolveQuotumCommand(["help"])).toEqual({ kind: "help", exitCode: 0 });
		expect(resolveQuotumCommand(["--help"])).toEqual({ kind: "help", exitCode: 0 });
		expect(resolveQuotumCommand([])).toMatchObject({ kind: "help", exitCode: 64 });
		expect(resolveQuotumCommand(["connections"])).toMatchObject({ kind: "help", exitCode: 64 });
		expect(resolveQuotumCommand(["catalogue"])).toMatchObject({ kind: "help", exitCode: 64 });
		expect(resolveQuotumCommand(["healthcheck", "--port", "1"])).toMatchObject({
			kind: "help",
			exitCode: 64,
		});
	});

	it("answers --help for every command without starting it", () => {
		for (const command of quotumCommands)
			for (const flag of ["--help", "-h"])
				expect(resolveQuotumCommand([...command.path, flag])).toEqual({
					kind: "help",
					exitCode: 0,
					command,
				});
	});

	it("rejects arguments a command would ignore or misread before starting a process", () => {
		for (const argv of [
			["migrate", "up"],
			["migrate", "status", "now"],
			["bootstrap"],
			["bootstrap", "--apply", "--credentials-out"],
			["bootstrap", "--apply", "--credentials-out", " "],
			["bootstrap", "--check", "--apply"],
			["catalog"],
			["catalog", "push"],
			["catalog", "status", "extra"],
			["catalog", "provision", "extra"],
			["connections", "rotate-secrets", "--force"],
			["merchant", "service-principal"],
			["mcp", "extra"],
		])
			expect(resolveQuotumCommand(argv)).toMatchObject({ kind: "help", exitCode: 64 });
	});

	it("lists every command in the help text", () => {
		const help = quotumHelp();
		for (const command of quotumCommands) expect(help).toContain(command.usage);
		for (const builtin of ["healthcheck", "init", "version", "help"])
			expect(help).toContain(builtin);
	});
});

describe("quotum dispatch", () => {
	it("prints help on stdout for help and on stderr with exit 64 for unknown commands", async () => {
		const help = recorder();
		expect(await runQuotumCli(["help"], help.dependencies)).toBe(0);
		expect(help.stdout.join("\n")).toContain("Usage: quotum <command>");
		expect(help.stderr).toEqual([]);

		const unknown = recorder();
		expect(await runQuotumCli(["nope"], unknown.dependencies)).toBe(64);
		expect(unknown.stdout).toEqual([]);
		expect(unknown.stderr[0]).toBe("Unknown command: nope");
		expect(unknown.spawned).toEqual([]);
	});

	it("never starts a command for its help or a usage error", async () => {
		const help = recorder();
		expect(await runQuotumCli(["migrate", "--help"], help.dependencies)).toBe(0);
		expect(help.stdout.join("\n")).toBe(
			[
				"Usage: quotum migrate [status]",
				"",
				"Apply pending migrations, or verify applied checksums with `status`",
				"Environment: POSTGRES_URI",
			].join("\n"),
		);
		const misuse = recorder();
		expect(await runQuotumCli(["connections", "rotate-secrets", "now"], misuse.dependencies)).toBe(
			64,
		);
		expect(misuse.stderr[0]).toBe("Unexpected arguments for quotum connections rotate-secrets.");
		expect([...help.spawned, ...misuse.spawned]).toEqual([]);
	});

	it("runs a command as a child without loading a .env file and returns its exit code", async () => {
		const run = recorder({
			spawn: (cmd) => {
				run.spawned.push(cmd);
				return { exited: Promise.resolve(3), kill: () => undefined };
			},
		});
		expect(await runQuotumCli(["migrate", "status"], run.dependencies)).toBe(3);
		expect(run.spawned).toEqual([
			[process.execPath, "--no-env-file", join(sourceRoot, "migrate.ts"), "status"],
		]);
	});

	it("forwards supervisor signals to the child until it exits", async () => {
		const signals = new EventEmitter();
		const killed: string[] = [];
		let exit: (code: number) => void = () => undefined;
		const child: QuotumChildProcess = {
			exited: new Promise<number>((resolve) => {
				exit = resolve;
			}),
			kill: (signal) => killed.push(signal),
		};
		const run = recorder({ signals, spawn: () => child });
		const exitCode = runQuotumCli(["mcp"], run.dependencies);
		await Bun.sleep(0);
		signals.emit("SIGTERM", "SIGTERM");
		signals.emit("SIGINT", "SIGINT");
		signals.emit("SIGHUP", "SIGHUP");
		exit(143);
		expect(await exitCode).toBe(143);
		expect(killed).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
		expect(signals.listenerCount("SIGTERM")).toBe(0);
		expect(signals.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGHUP")).toBe(0);
	});

	it("prints the image build version", async () => {
		const run = recorder({ env: { BUILD_VERSION: "1.2.3", BUILD_COMMIT: "abc123" } });
		expect(await runQuotumCli(["version"], run.dependencies)).toBe(0);
		expect(run.stdout).toEqual(["1.2.3 (abc123)"]);
		const checkout = recorder();
		expect(await runQuotumCli(["--version"], checkout.dependencies)).toBe(0);
		expect(checkout.stdout).toEqual(["0.0.0-dev"]);
	});
});

describe("quotum healthcheck", () => {
	it("passes only when /ready answers 200 on the configured port", async () => {
		let status = 200;
		const paths: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				paths.push(new URL(request.url).pathname);
				return new Response(null, { status });
			},
		});
		try {
			const ready = recorder({ env: { PORT: String(server.port) } });
			expect(await runQuotumCli(["healthcheck"], ready.dependencies)).toBe(0);
			expect(ready.stderr).toEqual([]);

			status = 503;
			const unready = recorder({ env: { PORT: String(server.port) } });
			expect(await runQuotumCli(["healthcheck"], unready.dependencies)).toBe(1);
			expect(unready.stderr).toEqual(["healthcheck: /ready answered 503"]);
			expect(paths).toEqual(["/ready", "/ready"]);
		} finally {
			server.stop(true);
		}
	});

	it("fails when the service is unreachable or PORT is invalid", async () => {
		const unreachable = recorder({
			fetch: () => Promise.reject(new Error("connection refused")),
		});
		expect(await runQuotumCli(["healthcheck"], unreachable.dependencies)).toBe(1);
		expect(unreachable.stderr).toEqual(["healthcheck: /ready is unreachable (connection refused)"]);

		const invalid = recorder({ env: { PORT: "http" } });
		expect(await runQuotumCli(["healthcheck"], invalid.dependencies)).toBe(1);
		expect(invalid.stderr[0]).toContain("PORT must be a TCP port");
	});
});
