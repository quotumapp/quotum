import { merchantPlatformEnabled } from "../../platform/config";
import { addOrganizationOwner } from "../../platform/operator-owner";
import {
	CliUsageError,
	type CommandOutput,
	memberOverrideReason,
	openOperatorSql,
	operatorActor,
	parseArguments,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface OrganizationsCommandDependencies {
	output?: CommandOutput;
}

export async function runOrganizationsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: OrganizationsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => organizationsCommand(argv, env),
		"quotum organizations --help",
		dependencies.output,
	);
}

async function organizationsCommand(argv: readonly string[], env: Environment): Promise<unknown> {
	const [subcommand, ...args] = argv;
	switch (subcommand) {
		case "add-owner": {
			const { positionals, options } = parseArguments(
				args,
				["email", "actor", "member-override-reason"],
				1,
			);
			const email = ownerEmail(options.get("email"));
			const operator = operatorActor(options, env);
			const reason = memberOverrideReason(options);
			if (!merchantPlatformEnabled(env))
				throw new Error(
					"The merchant platform is off (QUOTUM_CONSOLE_ENABLED is not true), so there is no merchant application for an owner to sign in to",
				);
			const database = openOperatorSql(env);
			try {
				return await addOrganizationOwner(database.sql, {
					organizationSlug: positionals[0] ?? "",
					email,
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

function ownerEmail(value: string | undefined): string {
	const email = value?.trim();
	if (email === undefined) throw new CliUsageError("--email <address> is required.");
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))
		throw new CliUsageError("--email must be one email address.");
	return email;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runOrganizationsCommand(process.argv.slice(2), process.env);
}
