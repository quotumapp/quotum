import { renderPlatformCredentialOutput } from "../../platform-bootstrap";
import {
	CliUsageError,
	type CommandOutput,
	CommandReport,
	memberOverrideReason,
	type OperatorContext,
	type OperatorContextDependencies,
	type OperatorTarget,
	openOperatorContext,
	operatorActor,
	parseArguments,
	requestKey,
	reserveSecretFile,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;
type Readiness = Awaited<ReturnType<OperatorContext["lifecycle"]["readiness"]>>;

export interface EnvironmentsCommandDependencies extends OperatorContextDependencies {
	output?: CommandOutput;
}

export async function runEnvironmentsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: EnvironmentsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => environmentsCommand(argv, env, dependencies),
		"quotum environments --help",
		dependencies.output,
	);
}

async function environmentsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: EnvironmentsCommandDependencies,
): Promise<unknown> {
	const [subcommand, ...args] = argv;
	switch (subcommand) {
		case "readiness": {
			const { positionals } = parseArguments(args, [], 1);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(positionals[0] ?? "");
				const readiness = await context.lifecycle.readiness(
					context.gate(target, "reader"),
					context.billing,
				);
				return readiness.ready
					? new CommandReport(readinessReport(target, readiness), 0)
					: new CommandReport(readinessReport(target, readiness), 2, notReadyNotice);
			});
		}
		case "activate": {
			const { positionals, options } = parseArguments(
				args,
				["credentials-out", "request-key", "actor", "member-override-reason"],
				1,
			);
			const credentialsOut = options.get("credentials-out");
			if (credentialsOut === undefined)
				throw new CliUsageError("--credentials-out <new-file> is required.");
			const key = requestKey(options);
			const actor = operatorActor(options, env);
			const reason = memberOverrideReason(options);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(positionals[0] ?? "");
				if (target.environment !== "production")
					throw new CliUsageError(
						`${target.instanceKey} is a ${target.environment} environment; only production is activated.`,
					);
				const gate = context.gate(target, actor, { memberOverrideReason: reason });
				const file = await reserveSecretFile(credentialsOut);
				try {
					// An active environment answers the same way whatever its readiness is now.
					const readiness = await context.lifecycle.readiness(gate, context.billing);
					if (!readiness.ready && readiness.lifecycleStatus !== "active") {
						await file.discard();
						return new CommandReport(
							{ requestKey: key, ...readinessReport(target, readiness), activated: false },
							2,
							notReadyNotice,
						);
					}
					// The key is written inside the activation's transaction, so a file that cannot be
					// written rolls the activation back instead of leaving a live key nobody holds.
					const { credentialDisclosed } = await context.lifecycle.activate(
						gate,
						context.billing,
						key,
						{
							fingerprint: null,
							deliver: (token) =>
								file.write(
									renderPlatformCredentialOutput([
										{ projectInstanceKey: target.instanceKey, token, access: "full" },
									]),
								),
						},
					);
					// A replay or an already-active environment returns no key.
					if (!credentialDisclosed) await file.discard();
					return {
						requestKey: key,
						instance: target.instanceKey,
						environment: target.environment,
						active: true,
						credentialDisclosed,
						credentialsOut: credentialDisclosed ? file.path : null,
					};
				} catch (error) {
					await file.discard();
					throw error;
				}
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

const notReadyNotice =
	"Not ready: resolve the blockers, refresh any stale connection validation, and run the command again.";

/** What an operator needs to unblock an environment; never any connection settings or secrets. */
function readinessReport(target: OperatorTarget, readiness: Readiness) {
	return {
		instance: target.instanceKey,
		environment: target.environment,
		lifecycleStatus: readiness.lifecycleStatus,
		ready: readiness.ready,
		blockers: readiness.blockers,
		blockerDetails: readiness.blockerDetails,
		catalogRevisionId: readiness.catalogRevisionId,
		connections: readiness.connections.map((row) => ({
			kind: row.kind,
			enabled: row.enabled,
			validatedAt: row.validated_at,
			eventVerifiedAt: row.event_verified_at,
		})),
		fingerprint: readiness.fingerprint,
	};
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

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runEnvironmentsCommand(process.argv.slice(2), process.env);
}
