import { listPlatformAuditEvents } from "../../platform/audit";
import {
	CliUsageError,
	type CommandOutput,
	openOperatorSql,
	parseArguments,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface AuditCommandDependencies {
	output?: CommandOutput;
}

const defaultLimit = 50;
const maxLimit = 500;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const actionPattern = /^[a-z][a-z0-9_.-]{0,99}$/;

export async function runAuditCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: AuditCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => auditCommand(argv, env),
		"quotum audit --help",
		dependencies.output,
	);
}

async function auditCommand(argv: readonly string[], env: Environment): Promise<unknown> {
	const [subcommand, ...args] = argv;
	switch (subcommand) {
		case "list": {
			const { options } = parseArguments(
				args,
				["organization", "action", "since", "until", "before", "limit"],
				0,
			);
			const filter = {
				organizationSlug: options.get("organization"),
				action: actionOption(options.get("action")),
				since: timestampOption("since", options.get("since")),
				until: timestampOption("until", options.get("until")),
				before: eventIdOption(options.get("before")),
				limit: limitOption(options.get("limit")),
			};
			const database = openOperatorSql(env);
			try {
				return await listPlatformAuditEvents(database.sql, filter);
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

function actionOption(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!actionPattern.test(value))
		throw new CliUsageError("--action must be an event name such as credential.rotated.");
	return value;
}

function timestampOption(name: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!timestampPattern.test(value) || Number.isNaN(Date.parse(value)))
		throw new CliUsageError(
			`--${name} must be an ISO 8601 timestamp with a zone, such as 2026-10-13T09:00:00Z.`,
		);
	return value;
}

function eventIdOption(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!uuidPattern.test(value)) throw new CliUsageError("--before must be an audit event id.");
	return value.toLowerCase();
}

function limitOption(value: string | undefined): number {
	if (value === undefined) return defaultLimit;
	const limit = /^\d{1,4}$/.test(value) ? Number(value) : 0;
	if (limit < 1 || limit > maxLimit)
		throw new CliUsageError(`--limit must be a whole number from 1 to ${maxLimit}.`);
	return limit;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runAuditCommand(process.argv.slice(2), process.env);
}
