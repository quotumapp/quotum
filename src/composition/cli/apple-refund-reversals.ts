import { z } from "zod";
import {
	applyAppleRefundReversalRepair,
	readAppleRefundReversalRepairs,
} from "../../db/repository/apple-refund-repairs";
import { insertPlatformAuditEvent } from "../../platform/audit";
import {
	CliUsageError,
	type CommandOutput,
	CommandReport,
	memberOverrideReason,
	openOperatorContext,
	operatorActor,
	parseArguments,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface AppleRefundReversalsCommandDependencies {
	output?: CommandOutput;
	open?: typeof openOperatorContext;
	report?: typeof readAppleRefundReversalRepairs;
	apply?: typeof applyAppleRefundReversalRepair;
}

export async function runAppleRefundReversalsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: AppleRefundReversalsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => command(argv, env, dependencies),
		"quotum repair apple-refund-reversals --help",
		dependencies.output,
	);
}

async function command(
	argv: readonly string[],
	env: Environment,
	dependencies: AppleRefundReversalsCommandDependencies,
): Promise<CommandReport> {
	const [subcommand, ...args] = argv;
	if (subcommand !== "report" && subcommand !== "apply")
		throw new CliUsageError("Expected report or apply.");
	const { positionals, options } = parseArguments(
		args,
		subcommand === "report" ? ["after", "limit"] : ["actor", "member-override-reason"],
		subcommand === "report" ? 1 : 2,
	);
	const instance = positionals[0] ?? "";
	const storeEventId = subcommand === "apply" ? uuid(positionals[1], "Store event id") : undefined;
	const after = options.has("after") ? uuid(options.get("after"), "--after") : undefined;
	const limit = reportLimit(options.get("limit"));
	const actor = subcommand === "apply" ? operatorActor(options, env) : "reader";
	const reason = memberOverrideReason(options);
	const context = await (dependencies.open ?? openOperatorContext)(env);
	try {
		const target = await context.target(instance);
		const gate = context.gate(target, actor, { memberOverrideReason: reason });
		await gate.instance(context.sql, subcommand === "apply");
		if (storeEventId === undefined) {
			const report = await (dependencies.report ?? readAppleRefundReversalRepairs)(
				context.billingDatabase,
				target.project.projectInstanceId,
				{ after, limit },
			);
			return new CommandReport(
				{ instance, ...report },
				report.events.some((event) => event.status === "blocked") ? 2 : 0,
			);
		}
		// As with the other operator billing commands, record acceptance before doing the work.
		await insertPlatformAuditEvent(context.sql, {
			principalId: null,
			organizationId: target.organizationId,
			action: "billing.action_accepted",
			target: target.instanceId,
			metadata: {
				operator: actor,
				...(reason === undefined ? {} : { memberOverrideReason: reason }),
				action: "apple.refund_reversal.repair",
				storeEventId,
				environment: target.environment,
			},
		});
		const result = await (dependencies.apply ?? applyAppleRefundReversalRepair)(
			context.billingDatabase,
			target.project.projectInstanceId,
			storeEventId,
		);
		return new CommandReport({ instance, ...result }, result.status === "blocked" ? 2 : 0);
	} finally {
		await context.close();
	}
}

function uuid(value: string | undefined, label: string): string {
	const parsed = z.uuid().safeParse(value);
	if (!parsed.success) throw new CliUsageError(`${label} must be a UUID.`);
	return parsed.data;
}

function reportLimit(value: string | undefined): number {
	if (value === undefined) return 100;
	if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 500)
		throw new CliUsageError("--limit must be a whole number from 1 to 500.");
	return Number(value);
}

if (import.meta.main) {
	process.exitCode = await runAppleRefundReversalsCommand(process.argv.slice(2), process.env);
}
