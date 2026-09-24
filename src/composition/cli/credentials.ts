import { renderPlatformCredentialOutput } from "../../platform-bootstrap";
import type { CredentialAccess } from "../../shared/credential-access";
import {
	CliUsageError,
	type CommandOutput,
	type OperatorContext,
	type OperatorContextDependencies,
	openOperatorContext,
	operatorActor,
	parseArguments,
	requestKey,
	reserveSecretFile,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface CredentialsCommandDependencies extends OperatorContextDependencies {
	output?: CommandOutput;
}

export async function runCredentialsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: CredentialsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => credentialsCommand(argv, env, dependencies),
		"quotum credentials --help",
		dependencies.output,
	);
}

async function credentialsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: CredentialsCommandDependencies,
): Promise<unknown> {
	const [subcommand, ...args] = argv;
	switch (subcommand) {
		case "status": {
			const { positionals } = parseArguments(args, [], 1);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(positionals[0] ?? "");
				return {
					instance: target.instanceKey,
					environment: target.environment,
					...(await context.lifecycle.credentialStatus(context.gate(target, "reader"))),
				};
			});
		}
		case "rotate": {
			const { positionals, options } = parseArguments(
				args,
				["access", "credentials-out", "request-key", "actor"],
				1,
			);
			// No default: rotating the full key replaces the one every backend uses.
			const access = credentialAccess(options.get("access"), ["full", "read_only"]);
			const credentialsOut = options.get("credentials-out");
			if (credentialsOut === undefined)
				throw new CliUsageError("--credentials-out <new-file> is required.");
			const key = requestKey(options);
			const actor = operatorActor(options, env);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(positionals[0] ?? "");
				const file = await reserveSecretFile(credentialsOut);
				try {
					// The key is written inside the rotation's transaction, so a file that cannot be
					// written rolls the rotation back instead of revoking the old key.
					const { credentialDisclosed } = await context.lifecycle.rotateCredential(
						context.gate(target, actor),
						key,
						access,
						(token) =>
							file.write(
								renderPlatformCredentialOutput([
									{ projectInstanceKey: target.instanceKey, token, access },
								]),
							),
					);
					// A replay returns the stored receipt, which never holds the key.
					if (!credentialDisclosed) await file.discard();
					return {
						requestKey: key,
						instance: target.instanceKey,
						access,
						credentialDisclosed,
						credentialsOut: credentialDisclosed ? file.path : null,
					};
				} catch (error) {
					await file.discard();
					throw error;
				}
			});
		}
		case "revoke": {
			const { positionals, options } = parseArguments(args, ["access", "request-key", "actor"], 1);
			// Only the read-only key can be withdrawn; the full key is only ever replaced.
			credentialAccess(options.get("access"), ["read_only"]);
			const key = requestKey(options);
			const actor = operatorActor(options, env);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(positionals[0] ?? "");
				return {
					requestKey: key,
					instance: target.instanceKey,
					...(await context.lifecycle.revokeCredential(context.gate(target, actor), key)),
				};
			});
		}
		default:
			throw new CliUsageError(
				subcommand === undefined
					? "Missing subcommand."
					: `Unknown subcommand ${JSON.stringify(subcommand)}.`,
			);
	}
}

async function withContext<T>(
	env: Environment,
	dependencies: OperatorContextDependencies,
	run: (context: OperatorContext) => Promise<T>,
): Promise<T> {
	const context = await openOperatorContext(env, dependencies);
	try {
		return await run(context);
	} finally {
		await context.close();
	}
}

function credentialAccess(
	value: string | undefined,
	allowed: readonly CredentialAccess[],
): CredentialAccess {
	const access = allowed.find((candidate) => candidate === value);
	if (access === undefined) throw new CliUsageError(`--access must be ${allowed.join(" or ")}.`);
	return access;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runCredentialsCommand(process.argv.slice(2), process.env);
}
