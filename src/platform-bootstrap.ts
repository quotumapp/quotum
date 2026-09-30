import { open, unlink } from "node:fs/promises";
import {
	CliUsageError,
	type CommandOutput,
	reportOperatorFailure,
} from "./composition/cli/operator-context";
import { BunPlatformUnitOfWork } from "./composition/project-instance-persistence";
import { createBillingDatabaseConnection } from "./db/client";
import {
	type PlatformBootstrapManifest,
	parsePlatformBootstrapManifest,
	platformBootstrapCredentialEnvironment,
} from "./platform/bootstrap/manifest";
import {
	type PlatformBootstrapInspection,
	type PlatformBootstrapResult,
	PlatformBootstrapService,
} from "./platform/bootstrap/service";
import { generateProjectApiCredential } from "./platform/credentials/project-api-token";
import { writeStderr, writeStdout } from "./shared/cli-output";
import type { CredentialAccess } from "./shared/credential-access";

type Environment = Readonly<Record<string, string | undefined>>;

export interface PlatformBootstrapCommandDependencies {
	output?: CommandOutput;
	/** Replaces the database-backed service, for tests. */
	openService?: (postgresUri: string) => {
		service: Pick<PlatformBootstrapService, "inspect" | "apply">;
		close(): Promise<void>;
	};
}

const help = "quotum bootstrap --help";

/** Runs `quotum bootstrap`; a failure is one line on stderr, never a stack trace. */
export async function runPlatformBootstrapCommand(
	args: readonly string[],
	env: Environment,
	dependencies: PlatformBootstrapCommandDependencies = {},
): Promise<number> {
	const output = dependencies.output ?? { stdout: writeStdout, stderr: writeStderr };
	try {
		const mode = parseMode(args);
		const postgresUri = requireEnvironmentValue(env, "POSTGRES_URI");
		const manifest = parsePlatformBootstrapManifest(
			requireEnvironmentValue(env, "BILLING_PLATFORM_BOOTSTRAP_JSON"),
		);
		const { service, close } = (dependencies.openService ?? openBootstrapService)(postgresUri);
		try {
			const inspection = await service.inspect(manifest);
			if (mode.kind === "check") {
				output.stdout(JSON.stringify(inspection, null, 2));
				return platformBootstrapCheckExitCode(inspection);
			}
			await applyPlatformBootstrap(
				service,
				manifest,
				inspection.credentialsToIssue,
				mode.credentialsOut,
				output.stdout,
				inspection.readOnlyCredentialsToIssue,
			);
			return 0;
		} finally {
			await close();
		}
	} catch (error) {
		return reportOperatorFailure(error, help, output);
	}
}

function openBootstrapService(postgresUri: string) {
	const connection = createBillingDatabaseConnection({ postgresUri });
	return {
		service: new PlatformBootstrapService(new BunPlatformUnitOfWork(connection.sql)),
		close: () => connection.sql.close(),
	};
}

/** 0 once every declared row and credential exists; 2 while `--apply` has something to do. */
export function platformBootstrapCheckExitCode(inspection: {
	state: PlatformBootstrapInspection["state"];
	credentialsToIssue: readonly string[];
	readOnlyCredentialsToIssue?: readonly string[];
}): 0 | 2 {
	return inspection.state === "exact" &&
		inspection.credentialsToIssue.length === 0 &&
		(inspection.readOnlyCredentialsToIssue ?? []).length === 0
		? 0
		: 2;
}

export async function applyPlatformBootstrap(
	service: Pick<PlatformBootstrapService, "apply">,
	manifest: PlatformBootstrapManifest,
	credentialsToIssue: readonly string[],
	credentialsOut: string | null,
	writeSummary: (message: string) => void = writeStdout,
	readOnlyCredentialsToIssue: readonly string[] = [],
): Promise<void> {
	if (
		credentialsToIssue.length + readOnlyCredentialsToIssue.length > 0 &&
		credentialsOut === null
	) {
		throw new CliUsageError("--credentials-out is required when bootstrap will issue credentials.");
	}

	const generate = (keys: readonly string[], access: CredentialAccess) =>
		keys.map((projectInstanceKey) => ({
			projectInstanceKey,
			...generateProjectApiCredential(
				platformBootstrapCredentialEnvironment(manifest, projectInstanceKey, access),
				access,
			),
		}));
	const generated = [
		...generate(credentialsToIssue, "full"),
		...generate(readOnlyCredentialsToIssue, "read_only"),
	];
	let outputCreated = false;
	let result: PlatformBootstrapResult;
	try {
		if (credentialsOut !== null && generated.length > 0) {
			await writePlatformCredentialOutput(credentialsOut, generated);
			outputCreated = true;
		}

		result = await service.apply(
			manifest,
			generated.map((credential) => ({
				credentialId: credential.credentialId,
				projectInstanceKey: credential.projectInstanceKey,
				environment: credential.environment,
				access: credential.access,
				secretVerifier: credential.secretVerifier,
			})),
		);
	} catch (error) {
		if (outputCreated && credentialsOut !== null) {
			await unlink(credentialsOut).catch(() => undefined);
		}
		throw error;
	}

	writeSummary(
		JSON.stringify(
			{
				state: result.state,
				organizationCount: result.organizationCount,
				logicalProjectCount: result.logicalProjectCount,
				projectInstanceCount: result.projectInstanceCount,
				organizationsCreated: result.organizationsCreated,
				logicalProjectsCreated: result.logicalProjectsCreated,
				projectInstancesCreated: result.projectInstancesCreated,
				credentialsIssued: result.credentialsIssued,
				credentialsOut: result.credentialsIssued > 0 ? credentialsOut : null,
			},
			null,
			2,
		),
	);
}

/**
 * Full keys keep their `credentials` array, one entry per instance, so existing readers are
 * unaffected. Read-only keys go to `readOnlyCredentials`, present only when any were issued.
 * `quotum credentials rotate` writes the same format.
 */
export function renderPlatformCredentialOutput(
	credentials: readonly { projectInstanceKey: string; token: string; access?: CredentialAccess }[],
): string {
	const entries = (access: CredentialAccess) =>
		credentials
			.filter((credential) => (credential.access ?? "full") === access)
			.map((credential) => ({
				projectInstanceKey: credential.projectInstanceKey,
				credential: credential.token,
			}));
	const readOnly = entries("read_only");
	return `${JSON.stringify(
		{
			version: 1,
			credentials: entries("full"),
			...(readOnly.length === 0 ? {} : { readOnlyCredentials: readOnly }),
		},
		null,
		2,
	)}\n`;
}

export async function writePlatformCredentialOutput(
	path: string,
	credentials: readonly { projectInstanceKey: string; token: string; access?: CredentialAccess }[],
): Promise<void> {
	let output: Awaited<ReturnType<typeof open>> | undefined;
	try {
		output = await open(path, "wx", 0o600).catch((error: unknown) => {
			throw credentialOutputError(path, error);
		});
		await output.writeFile(renderPlatformCredentialOutput(credentials), { encoding: "utf8" });
		await output.sync();
	} catch (error) {
		if (output !== undefined) await unlink(path).catch(() => undefined);
		throw error;
	} finally {
		await output?.close();
	}
}

/** Why the credentials file could not be created, keeping the system error's `code`. */
function credentialOutputError(path: string, error: unknown): Error {
	const code = (error as { code?: unknown } | null)?.code;
	const reason =
		code === "EEXIST"
			? "already exists; bootstrap never overwrites a credentials file"
			: code === "ENOENT"
				? "cannot be created: its directory does not exist"
				: code === "EACCES" || code === "EPERM"
					? "cannot be created: permission denied"
					: `cannot be created: ${error instanceof Error ? error.message : String(error)}`;
	return Object.assign(new Error(`--credentials-out ${path} ${reason}`, { cause: error }), {
		code,
	});
}

function parseMode(
	args: readonly string[],
): { kind: "check" } | { kind: "apply"; credentialsOut: string | null } {
	if (args.length === 1 && args[0] === "--check") return { kind: "check" };
	if (args[0] === "--apply" && args.length === 1) return { kind: "apply", credentialsOut: null };
	if (
		args[0] === "--apply" &&
		args.length === 3 &&
		args[1] === "--credentials-out" &&
		args[2]?.trim() !== ""
	) {
		return { kind: "apply", credentialsOut: args[2] ?? null };
	}
	throw new CliUsageError("Usage: quotum bootstrap --check | --apply [--credentials-out <path>].");
}

function requireEnvironmentValue(env: Environment, name: string): string {
	const value = env[name]?.trim();
	if (value === undefined || value === "")
		throw new Error(`${name} environment variable is required`);
	return value;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runPlatformBootstrapCommand(process.argv.slice(2), process.env);
}
