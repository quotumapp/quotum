import { merchantPlatformEnabled } from "../../platform/config";
import { resetSecondFactor } from "../../platform/operator-second-factor";
import {
	CliUsageError,
	type CommandOutput,
	openOperatorSql,
	operatorActor,
	parseArguments,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface SecondFactorCommandDependencies {
	output?: CommandOutput;
}

export async function runSecondFactorCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: SecondFactorCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => secondFactorCommand(argv, env),
		"quotum second-factor --help",
		dependencies.output,
	);
}

// The reason is kept in the audit event and shown in terminals: no control, format or separator
// characters, as with a member override reason.
const reasonPattern = /^[^\p{C}\p{Zl}\p{Zp}]{1,200}$/u;

async function secondFactorCommand(argv: readonly string[], env: Environment): Promise<unknown> {
	const [subcommand, ...args] = argv;
	switch (subcommand) {
		case "reset": {
			const { options } = parseArguments(args, ["email", "reason", "actor"], 0);
			const email = personEmail(options.get("email"));
			const reason = resetReason(options.get("reason"));
			const operator = operatorActor(options, env);
			if (!merchantPlatformEnabled(env))
				throw new Error(
					"The merchant platform is off (QUOTUM_CONSOLE_ENABLED is not true), so no one signs in with an authenticator",
				);
			const database = openOperatorSql(env);
			try {
				return await resetSecondFactor(database.sql, { email, operator, reason });
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

function personEmail(value: string | undefined): string {
	const email = value?.trim();
	if (email === undefined) throw new CliUsageError("--email <address> is required.");
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))
		throw new CliUsageError("--email must be one email address.");
	return email;
}

function resetReason(value: string | undefined): string {
	const reason = value?.trim();
	if (reason === undefined) throw new CliUsageError("--reason <why> is required.");
	if (!reasonPattern.test(reason))
		throw new CliUsageError("--reason must be 1-200 printable characters.");
	return reason;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runSecondFactorCommand(process.argv.slice(2), process.env);
}
