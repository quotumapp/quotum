import { syncLicensePoolPage } from "../../db/repository/license-pools";
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
export async function runLicensesCommand(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	dependencies: {
		open?: typeof openOperatorContext;
		sync?: typeof syncLicensePoolPage;
		output?: CommandOutput;
	} = {},
): Promise<number> {
	return runOperatorCommand(
		async () => {
			if (argv[0] !== "sync") throw new CliUsageError("Expected licenses sync.");
			const { options } = parseArguments(
				argv.slice(1),
				["instance", "actor", "member-override-reason", "after", "limit"],
				0,
			);
			const instance = options.get("instance");
			if (!instance?.trim()) throw new CliUsageError("--instance is required.");
			const actor = operatorActor(options, env);
			const reason = memberOverrideReason(options);
			const after = options.get("after") ?? null;
			if (
				after !== null &&
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)
			)
				throw new CliUsageError("--after must be a UUID.");
			const rawLimit = options.get("limit") ?? "100";
			const limit = Number(rawLimit);
			if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 500)
				throw new CliUsageError("--limit must be between 1 and 500.");
			const context = await (dependencies.open ?? openOperatorContext)(env);
			try {
				const target = await context.target(instance);
				await context
					.gate(target, actor, { memberOverrideReason: reason })
					.instance(context.sql, true);
				await insertPlatformAuditEvent(context.sql, {
					principalId: null,
					organizationId: target.organizationId,
					action: "billing.action_accepted",
					target: target.instanceId,
					metadata: {
						operator: actor,
						action: "licenses.sync",
						after,
						limit,
						...(reason === undefined ? {} : { memberOverrideReason: reason }),
					},
				});
				const result = await (dependencies.sync ?? syncLicensePoolPage)(
					context.billingDatabase,
					target.project.projectInstanceId,
					after,
					limit,
				);
				return new CommandReport({ instance, ...result }, 0);
			} finally {
				await context.close();
			}
		},
		"quotum licenses sync --help",
		dependencies.output,
	);
}
if (import.meta.main)
	process.exitCode = await runLicensesCommand(process.argv.slice(2), process.env);
