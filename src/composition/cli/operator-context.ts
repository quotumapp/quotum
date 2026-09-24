import { randomUUID } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import { SQL } from "bun";
import { loadPostgresPreparedStatements, loadProjectionReceivers } from "../../env";
import { loadAuthSecret, merchantPlatformEnabled } from "../../platform/config";
import { loadConnectionCipher } from "../../platform/connections/cipher";
import { type ConnectionGate, ConnectionLifecycle } from "../../platform/connections/lifecycle";
import {
	type OperatorConnectionTarget,
	operatorConnectionGate,
} from "../../platform/connections/operator-gate";
import type { ConnectionValidationPort } from "../../platform/connections/ports";
import { ConnectionRepository } from "../../platform/connections/repository";
import type { MerchantSql } from "../../platform/database";
import { MerchantError, tokenHash } from "../../platform/security";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import { createConnectionValidation } from "../connection-validation";
import { merchantSql } from "../merchant-persistence";
import { PostgresProjectInstanceContextResolver } from "../project-instance-persistence";
import { projectionDestinationPolicy } from "../projection-destinations";

type Environment = Readonly<Record<string, string | undefined>>;

/** Wrong arguments: the command exits 64 before it touches the database. */
export class CliUsageError extends Error {}

export interface ParsedArguments {
	positionals: string[];
	options: Map<string, string>;
}

/** Every option takes a value; unknown and repeated options are usage errors. */
export function parseArguments(
	args: readonly string[],
	allowed: readonly string[],
	positionalCount: number,
): ParsedArguments {
	const positionals: string[] = [];
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (!allowed.includes(name)) throw new CliUsageError(`Unknown option ${arg}.`);
		if (options.has(name)) throw new CliUsageError(`${arg} is given more than once.`);
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--"))
			throw new CliUsageError(`${arg} needs a value.`);
		options.set(name, value);
		index += 1;
	}
	if (positionals.length !== positionalCount)
		throw new CliUsageError(
			`Expected ${positionalCount} argument${positionalCount === 1 ? "" : "s"} before the options.`,
		);
	return { positionals, options };
}

const actorPattern = /^[A-Za-z0-9._@-]{1,64}$/;
const requestKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

/** The name audit events record for a change: `--actor`, or `QUOTUM_ACTOR`. */
export function operatorActor(options: ParsedArguments["options"], env: Environment): string {
	const actor = options.get("actor") ?? env.QUOTUM_ACTOR?.trim();
	if (!actor) throw new CliUsageError("Name the operator with --actor or QUOTUM_ACTOR.");
	if (!actorPattern.test(actor))
		throw new CliUsageError("--actor must be 1-64 letters, digits, '.', '_', '@' or '-'.");
	return actor;
}

/** `--request-key` makes a retry safe; without one, each run gets a new key and prints it. */
export function requestKey(options: ParsedArguments["options"]): string {
	const key = options.get("request-key") ?? `cli-${randomUUID()}`;
	if (!requestKeyPattern.test(key))
		throw new CliUsageError("--request-key must be 8-128 letters, digits, '.', '_', ':' or '-'.");
	return key;
}

const maxInputBytes = 64 * 1024;

async function readCapped(source: string, stdin: () => Promise<Uint8Array>): Promise<string> {
	let bytes: Uint8Array;
	if (source === "-") bytes = await stdin();
	else {
		const size = (await stat(source)).size;
		if (size > maxInputBytes) throw new CliUsageError(`${source} is larger than 64 KB.`);
		bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
	}
	if (bytes.byteLength > maxInputBytes) throw new CliUsageError("The input is larger than 64 KB.");
	return new TextDecoder().decode(bytes);
}

/** Reads a JSON object of settings from a file. */
export async function readSettings(
	path: string,
	stdin: () => Promise<Uint8Array>,
): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readCapped(path, stdin));
	} catch (error) {
		if (error instanceof CliUsageError) throw error;
		throw new CliUsageError(`${path} is not valid JSON.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new CliUsageError(`${path} must hold a JSON object.`);
	return parsed as Record<string, unknown>;
}

/**
 * Reads a JSON object of string secrets from a file, or from stdin for `-`. Secrets never come
 * from arguments, which other users can see, and no error repeats the input.
 */
export async function readSecrets(
	source: string,
	stdin: () => Promise<Uint8Array>,
): Promise<Record<string, string>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readCapped(source, stdin));
	} catch (error) {
		if (error instanceof CliUsageError) throw error;
		throw new CliUsageError("The secrets input is not valid JSON.");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!Object.values(parsed).every((value) => typeof value === "string")
	)
		throw new CliUsageError("The secrets input must be a JSON object of string values.");
	return parsed as Record<string, string>;
}

/** Reads stdin up to the input cap. */
export async function readStdin(): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of Bun.stdin.stream()) {
		length += chunk.byteLength;
		if (length > maxInputBytes) throw new CliUsageError("The input is larger than 64 KB.");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export interface SecretFile {
	readonly path: string;
	write(content: string): Promise<void>;
	discard(): Promise<void>;
}

/**
 * Creates a new owner-only file before anything changes, so a one-time secret always has somewhere
 * to go. An existing path is refused rather than overwritten.
 */
export async function reserveSecretFile(path: string): Promise<SecretFile> {
	const handle = await open(path, "wx", 0o600);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await handle.close();
	};
	return {
		path,
		async write(content) {
			try {
				await handle.writeFile(content, { encoding: "utf8" });
				await handle.sync();
				await close();
			} catch (error) {
				await close().catch(() => undefined);
				await unlink(path).catch(() => undefined);
				throw error;
			}
		},
		async discard() {
			await close().catch(() => undefined);
			await unlink(path).catch(() => undefined);
		},
	};
}

export interface OperatorContextDependencies {
	/** Replaces provider and receiver validation, for tests. */
	validator?: ConnectionValidationPort;
}

export interface OperatorTarget extends OperatorConnectionTarget {
	instanceKey: string;
}

export interface OperatorContext {
	readonly sql: MerchantSql;
	readonly repository: ConnectionRepository;
	readonly lifecycle: ConnectionLifecycle;
	target(instanceKey: string): Promise<OperatorTarget>;
	gate(target: OperatorTarget, actor: string): ConnectionGate;
	close(): Promise<void>;
}

/**
 * Connects the connection lifecycle to the database for one operator command. Settings are checked
 * before connecting: the connection key, the auth secret that keys receipts like the merchant
 * platform's, and the projection receiver policy, which only a headless deployment may widen.
 */
export async function openOperatorContext(
	env: Environment,
	dependencies: OperatorContextDependencies = {},
): Promise<OperatorContext> {
	const postgresUri = env.POSTGRES_URI?.trim();
	if (!postgresUri) throw new Error("POSTGRES_URI is required");
	const merchantEnabled = merchantPlatformEnabled(env);
	const destinationPolicy = projectionDestinationPolicy(
		{ projectionReceivers: loadProjectionReceivers(env) },
		merchantEnabled,
	);
	const secret = loadAuthSecret(env);
	const cipher = loadConnectionCipher(env);
	// A transaction-mode pooler needs BILLING_POSTGRES_PREPARED_STATEMENTS=false here as well.
	const prepare = loadPostgresPreparedStatements(env);
	const client = new SQL(postgresUri, { max: 2, prepare });
	const sql = merchantSql(client);
	const repository = new ConnectionRepository(sql, cipher);
	const lifecycle = new ConnectionLifecycle({
		sql,
		repository,
		validator: dependencies.validator ?? createConnectionValidation({ destinationPolicy }),
		hash: (value) => tokenHash(value, secret),
		now: () => new Date(),
	});
	const resolver = new PostgresProjectInstanceContextResolver(client);
	return {
		sql,
		repository,
		lifecycle,
		async target(instanceKey) {
			const lookup = await resolver.resolveInstanceKey(instanceKey);
			if (lookup.kind === "not_found")
				throw new Error(`Project instance ${instanceKey} was not found`);
			if (lookup.kind !== "resolved")
				throw new Error(`Project instance ${instanceKey} is not available`);
			const { context } = lookup;
			if (context.internalProject || context.environment === "internal")
				throw new Error(`Project instance ${instanceKey} is internal and has no connections`);
			return {
				instanceKey,
				organizationId: context.organizationId,
				platformProjectId: context.logicalProjectId,
				instanceId: context.projectInstanceId,
				environment: context.environment,
			};
		},
		gate: (target, actor) =>
			operatorConnectionGate(actor, target, { allowMemberOrganizations: !merchantEnabled }),
		close: () => client.close(),
	};
}

export interface CommandOutput {
	stdout(value: string): void;
	stderr(value: string): void;
}

/** A result whose exit code says what it found, with an optional note for the operator. */
export class CommandReport {
	constructor(
		readonly value: unknown,
		readonly exitCode: 0 | 1 | 2,
		readonly notice?: string,
	) {}
}

/** Prints the result as JSON on stdout and any failure on stderr; returns the exit code. */
export async function runOperatorCommand(
	run: () => Promise<unknown>,
	help: string,
	output: CommandOutput = { stdout: writeStdout, stderr: writeStderr },
): Promise<number> {
	try {
		const result = await run();
		const report = result instanceof CommandReport ? result : new CommandReport(result, 0);
		output.stdout(JSON.stringify(report.value, null, 2));
		if (report.notice !== undefined) output.stderr(report.notice);
		return report.exitCode;
	} catch (error) {
		if (error instanceof CliUsageError) {
			output.stderr(`${error.message} Run \`${help}\` for usage.`);
			return 64;
		}
		output.stderr(
			error instanceof MerchantError
				? `${error.code}: ${error.message}`
				: error instanceof Error
					? error.message
					: String(error),
		);
		return 1;
	}
}
