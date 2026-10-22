import { setEnvironmentSuspension } from "../../platform/operator-topology";
import {
	CliUsageError,
	type CommandOutput,
	CommandReport,
	memberOverrideReason,
	type OperatorContext,
	type OperatorContextDependencies,
	type OperatorTarget,
	openOperatorContext,
	openOperatorInstances,
	operatorActor,
	parseArguments,
	runOperatorCommand,
	statedReason,
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
		case "suspend":
		case "resume": {
			const suspended = subcommand === "suspend";
			const { positionals, options } = parseArguments(
				args,
				["reason", "actor", "member-override-reason"],
				1,
			);
			const reason = statedReason(options, "reason");
			if (suspended && reason === undefined)
				throw new CliUsageError("--reason <why> is required to suspend an environment.");
			const operator = operatorActor(options, env);
			const override = memberOverrideReason(options);
			const database = openOperatorInstances(env);
			try {
				const target = await database.target(positionals[0] ?? "");
				return await setEnvironmentSuspension(database.sql, {
					target,
					suspended,
					reason,
					operator,
					memberOverrideReason: override,
				});
			} finally {
				await database.close();
			}
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
	"Setup findings are informational; environment access and credential issuance remain available.";

/** Informational environment setup diagnostics; never any connection settings or secrets. */
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
