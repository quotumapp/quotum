import { join } from "node:path";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import { renderInitEnv } from "./init";

/** An operator command that runs as its own process, so its module state and exit code are its own. */
export interface QuotumCommand {
	/** Words after `quotum` that select the command. */
	readonly path: readonly string[];
	/** Entry file, relative to `src/`. */
	readonly file: string;
	readonly usage: string;
	readonly summary: string;
	/** Settings the command reads, shown by `quotum <command> --help`. */
	readonly environment: string;
	/** Further usage lines for `quotum <command> --help`. */
	readonly details?: readonly string[];
	/**
	 * Whether the entry file understands these arguments. Checked before the process starts:
	 * some entries ignore unexpected arguments, and `migrate.ts` applies pending migrations for
	 * anything other than `status`, so `quotum migrate --help` must never reach it.
	 */
	readonly accepts: (args: readonly string[]) => boolean;
}

const none = (args: readonly string[]) => args.length === 0;

export const quotumCommands: readonly QuotumCommand[] = [
	{
		path: ["migrate"],
		file: "migrate.ts",
		usage: "migrate [status]",
		summary: "Apply pending migrations, or verify applied checksums with `status`",
		environment: "POSTGRES_URI",
		accepts: (args) => none(args) || (args.length === 1 && args[0] === "status"),
	},
	{
		path: ["bootstrap"],
		file: "platform-bootstrap.ts",
		usage: "bootstrap --check | --apply [--credentials-out <path>]",
		summary: "Apply the BILLING_PLATFORM_BOOTSTRAP_JSON topology and issue its credentials",
		environment: "POSTGRES_URI, BILLING_PLATFORM_BOOTSTRAP_JSON",
		accepts: (args) =>
			(args.length === 1 && (args[0] === "--check" || args[0] === "--apply")) ||
			(args.length === 3 &&
				args[0] === "--apply" &&
				args[1] === "--credentials-out" &&
				args[2]?.trim() !== ""),
	},
	{
		path: ["catalog", "provision"],
		file: "composition/cli/catalog-provision.ts",
		usage: "catalog provision",
		summary: "Import the store products declared in BILLING_CATALOG_IMPORT_JSON",
		environment: "POSTGRES_URI, BILLING_CATALOG_IMPORT_JSON",
		accepts: none,
	},
	{
		path: ["catalog"],
		file: "composition/cli/catalog.ts",
		usage: "catalog status | diff <file> | push <file>",
		summary: "Read, preview or publish the catalog through the API",
		environment:
			"BILLING_BASE_URL, BILLING_PROJECT_API_KEY (or BILLING_PROJECT_KEY), BILLING_OPERATOR_API_KEY, optional BILLING_ACTOR",
		accepts: (args) =>
			(args.length === 1 && args[0] === "status") ||
			(args.length === 2 && (args[0] === "diff" || args[0] === "push")),
	},
	{
		path: ["connections", "rotate-secrets"],
		file: "composition/cli/connections-rotate-secrets.ts",
		usage: "connections rotate-secrets",
		summary: "Re-encrypt stored connection secrets with the active key",
		environment:
			"POSTGRES_URI, QUOTUM_SECRETS_KEY_ID, QUOTUM_SECRETS_KEY_BASE64, QUOTUM_SECRETS_PREVIOUS_KEY_ID, QUOTUM_SECRETS_PREVIOUS_KEY_BASE64",
		accepts: none,
	},
	{
		path: ["connections"],
		file: "composition/cli/connections.ts",
		usage: "connections list|draft|validate|commit|disable <instance> ...",
		summary: "Configure an instance's Stripe, Apple, Google and projection connections",
		environment:
			"POSTGRES_URI, QUOTUM_SECRETS_KEY_ID, QUOTUM_SECRETS_KEY_BASE64, QUOTUM_AUTH_SECRET, optional QUOTUM_ACTOR and BILLING_PROJECTION_* receiver settings",
		details: [
			"  connections list <instance>",
			"  connections draft <instance> <stripe|apple|google|projection> --settings <file>",
			"      [--secrets-file <file>|-] [--secret-out <new-file>] [--expected-revision <n>]",
			"  connections validate <instance> <kind> <draft-id>",
			"  connections commit <instance> <kind> <draft-id> [--wait-for-event <90s|10m>]",
			"  connections disable <instance> <kind> --expected-revision <n>",
			"Changes take --actor <name> (or QUOTUM_ACTOR) and an optional --request-key <key> for safe",
			"retries. Secrets come only from --secrets-file or stdin (-). A projection draft writes the",
			"generated receiver secret to --secret-out.",
		],
		accepts: (args) => ["list", "draft", "validate", "commit", "disable"].includes(args[0] ?? ""),
	},
	{
		path: ["credentials"],
		file: "composition/cli/credentials.ts",
		usage: "credentials status|rotate|revoke <instance> ...",
		summary: "Inspect, rotate or revoke an instance's project API credentials",
		environment:
			"POSTGRES_URI, QUOTUM_SECRETS_KEY_ID, QUOTUM_SECRETS_KEY_BASE64, QUOTUM_AUTH_SECRET, optional QUOTUM_ACTOR",
		details: [
			"  credentials status <instance>",
			"  credentials rotate <instance> --access full|read_only --credentials-out <new-file>",
			"  credentials revoke <instance> --access read_only",
			"Changes take --actor <name> (or QUOTUM_ACTOR) and an optional --request-key <key> for safe",
			"retries. Rotation revokes the replaced key at once and writes the new one only to",
			"--credentials-out, in the platform bootstrap's format.",
		],
		accepts: (args) => ["status", "rotate", "revoke"].includes(args[0] ?? ""),
	},
	{
		path: ["merchant", "service-principal"],
		file: "composition/cli/merchant-service-principal.ts",
		usage: "merchant service-principal <name>",
		summary: "Create the merchant proxy's service token, printed once",
		environment: "POSTGRES_URI and the merchant platform settings",
		accepts: (args) => args.length === 1,
	},
	{
		path: ["mcp"],
		file: "mcp/index.ts",
		usage: "mcp",
		summary: "Run the read-only MCP server over stdio",
		environment: "QUOTUM_MCP_BASE_URL, QUOTUM_MCP_API_KEY",
		accepts: none,
	},
];

const builtinCommands = [
	{ usage: "healthcheck", summary: "Exit 0 when this instance's /ready answers 200" },
	{ usage: "init", summary: "Print newly generated secrets for a new deployment" },
	{ usage: "version", summary: "Print the build version" },
	{ usage: "help", summary: "Show this help" },
] as const;

const isHelpFlag = (arg: string) => arg === "--help" || arg === "-h";

export type QuotumCliResolution =
	| { kind: "help"; exitCode: 0 | 64; message?: string; command?: QuotumCommand }
	| { kind: "builtin"; name: "healthcheck" | "init" | "version" }
	| { kind: "command"; command: QuotumCommand; args: readonly string[] };

export function resolveQuotumCommand(argv: readonly string[]): QuotumCliResolution {
	const [first, ...rest] = argv;
	if (first === undefined) return { kind: "help", exitCode: 64, message: "Missing command." };
	if (first === "help" || isHelpFlag(first)) return { kind: "help", exitCode: 0 };
	if (first === "--version") return { kind: "builtin", name: "version" };
	if (first === "healthcheck" || first === "init" || first === "version") {
		if (rest.some(isHelpFlag)) return { kind: "help", exitCode: 0 };
		if (rest.length > 0)
			return { kind: "help", exitCode: 64, message: `${first} takes no arguments.` };
		return { kind: "builtin", name: first };
	}
	let match: QuotumCommand | undefined;
	for (const command of quotumCommands) {
		const selected = command.path.every((word, index) => argv[index] === word);
		if (selected && command.path.length > (match?.path.length ?? 0)) match = command;
	}
	if (match === undefined)
		return { kind: "help", exitCode: 64, message: `Unknown command: ${argv.join(" ")}` };
	const args = argv.slice(match.path.length);
	if (args.some(isHelpFlag)) return { kind: "help", exitCode: 0, command: match };
	if (!match.accepts(args))
		return {
			kind: "help",
			exitCode: 64,
			message: `Unexpected arguments for quotum ${match.path.join(" ")}.`,
			command: match,
		};
	return { kind: "command", command: match, args };
}

export function quotumCommandHelp(command: QuotumCommand): string {
	return [
		`Usage: quotum ${command.usage}`,
		...(command.details === undefined ? [] : ["", ...command.details]),
		"",
		command.summary,
		`Environment: ${command.environment}`,
	].join("\n");
}

export function quotumHelp(): string {
	const rows = [
		...quotumCommands.map((command) => [command.usage, command.summary] as const),
		...builtinCommands.map((command) => [command.usage, command.summary] as const),
	];
	const width = Math.max(...rows.map(([usage]) => usage.length));
	return [
		"Usage: quotum <command> [arguments]",
		"",
		"Commands:",
		...rows.map(([usage, summary]) => `  ${usage.padEnd(width)}  ${summary}`),
		"",
		"Commands read their settings from the environment; see docs/deployment.md.",
	].join("\n");
}

export interface QuotumChildProcess {
	/** Resolves to the exit code, or 128 plus the signal number when a signal ended the process. */
	readonly exited: Promise<number>;
	kill(signal: NodeJS.Signals): void;
}

export interface QuotumSignalSource {
	on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
	off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface QuotumCliDependencies {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly spawn: (cmd: string[]) => QuotumChildProcess;
	readonly signals: QuotumSignalSource;
	readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	readonly now: () => Date;
}

/** Signals a supervisor such as Docker or tini sends to the CLI itself rather than to its child. */
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const sourceRoot = join(import.meta.dir, "..", "..");

export async function runQuotumCli(
	argv: readonly string[],
	overrides: Partial<QuotumCliDependencies> = {},
): Promise<number> {
	const dependencies: QuotumCliDependencies = {
		env: process.env,
		spawn: (cmd) => Bun.spawn({ cmd, stdio: ["inherit", "inherit", "inherit"] }),
		signals: process,
		fetch: (url, init) => fetch(url, init),
		stdout: writeStdout,
		stderr: writeStderr,
		now: () => new Date(),
		...overrides,
	};
	const resolution = resolveQuotumCommand(argv);
	switch (resolution.kind) {
		case "help": {
			const write = resolution.exitCode === 0 ? dependencies.stdout : dependencies.stderr;
			if (resolution.message !== undefined) write(resolution.message);
			write(resolution.command ? quotumCommandHelp(resolution.command) : quotumHelp());
			return resolution.exitCode;
		}
		case "builtin":
			if (resolution.name === "healthcheck") return healthcheck(dependencies);
			if (resolution.name === "init") dependencies.stdout(renderInitEnv(dependencies.now()));
			else dependencies.stdout(buildVersion(dependencies.env));
			return 0;
		case "command":
			return runChild(
				[
					process.execPath,
					"--no-env-file",
					join(sourceRoot, resolution.command.file),
					...resolution.args,
				],
				dependencies,
			);
	}
}

async function runChild(cmd: string[], dependencies: QuotumCliDependencies): Promise<number> {
	const child = dependencies.spawn(cmd);
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	for (const signal of forwardedSignals) dependencies.signals.on(signal, forward);
	try {
		return await child.exited;
	} finally {
		for (const signal of forwardedSignals) dependencies.signals.off(signal, forward);
	}
}

async function healthcheck(dependencies: QuotumCliDependencies): Promise<number> {
	const port = dependencies.env.PORT?.trim() || "3000";
	if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65_535) {
		dependencies.stderr(`healthcheck: PORT must be a TCP port, got ${JSON.stringify(port)}`);
		return 1;
	}
	try {
		const response = await dependencies.fetch(`http://127.0.0.1:${port}/ready`, {
			signal: AbortSignal.timeout(3000),
		});
		await response.body?.cancel();
		if (response.status === 200) return 0;
		dependencies.stderr(`healthcheck: /ready answered ${response.status}`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		dependencies.stderr(`healthcheck: /ready is unreachable (${reason})`);
	}
	return 1;
}

function buildVersion(env: Readonly<Record<string, string | undefined>>): string {
	const version = env.BUILD_VERSION?.trim() || "0.0.0-dev";
	const commit = env.BUILD_COMMIT?.trim();
	return commit ? `${version} (${commit})` : version;
}
