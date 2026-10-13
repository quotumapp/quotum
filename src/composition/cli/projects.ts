import { renameProject } from "../../platform/operator-topology";
import {
	CliUsageError,
	type CommandOutput,
	displayNameOption,
	memberOverrideReason,
	openOperatorSql,
	operatorActor,
	parseArguments,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ProjectsCommandDependencies {
	output?: CommandOutput;
}

export async function runProjectsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: ProjectsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => projectsCommand(argv, env),
		"quotum projects --help",
		dependencies.output,
	);
}

async function projectsCommand(argv: readonly string[], env: Environment): Promise<unknown> {
	const [subcommand, ...args] = argv;
	switch (subcommand) {
		case "rename": {
			const { positionals, options } = parseArguments(
				args,
				["name", "actor", "member-override-reason"],
				2,
			);
			const name = displayNameOption(options);
			const operator = operatorActor(options, env);
			const reason = memberOverrideReason(options);
			const database = openOperatorSql(env);
			try {
				return await renameProject(database.sql, {
					organizationSlug: positionals[0] ?? "",
					projectKey: positionals[1] ?? "",
					name,
					operator,
					memberOverrideReason: reason,
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

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runProjectsCommand(process.argv.slice(2), process.env);
}
