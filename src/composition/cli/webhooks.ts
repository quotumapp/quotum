import { z } from "zod";
import {
	webhookDeliveryListQuerySchema,
	webhookEndpointCreateBodySchema,
	webhookEndpointUpdateBodySchema,
	webhookReplayBodySchema,
	webhookSecretRotationBodySchema,
} from "../../app/webhook-endpoint-routes";
import { BillingError } from "../../billing/errors";
import type { WebhookEndpointServiceLike } from "../../events/endpoints";
import { insertPlatformAuditEvent } from "../../platform/audit";
import { BillingApiError } from "../../sdk/client";
import { describeRequestIssues, requestIssues } from "../../shared/request-issues";
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
	type ParsedArguments,
	parseArguments,
	requestKey,
	reserveSecretFile,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface WebhooksCommandDependencies extends OperatorContextDependencies {
	output?: CommandOutput;
}

export async function runWebhooksCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: WebhooksCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => webhooksCommand(argv, env, dependencies),
		"quotum webhooks --help",
		dependencies.output,
	);
}

const changeOptions = ["actor", "member-override-reason"];

/** What a change names: the operator, recorded as `operator:<name>`, and why, for member organizations. */
interface Change {
	actor: string;
	reason: string | undefined;
}

function change(options: ParsedArguments["options"], env: Environment): Change {
	return { actor: operatorActor(options, env), reason: memberOverrideReason(options) };
}

async function webhooksCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: WebhooksCommandDependencies,
): Promise<unknown> {
	const [group, subcommand, ...args] = argv;
	const command = `${group ?? ""} ${subcommand ?? ""}`.trim();
	switch (command) {
		case "endpoints list": {
			const { positionals } = parseArguments(args, [], 1);
			return await read(env, dependencies, positionals[0], async (service, target) => ({
				instance: target.instanceKey,
				environment: target.environment,
				endpoints: await service.listEndpoints(target.project),
			}));
		}
		case "endpoints create": {
			const { positionals, options } = parseArguments(
				args,
				[
					"url",
					"event-types",
					"description",
					"enabled",
					"secret-out",
					"request-key",
					...changeOptions,
				],
				1,
			);
			const secretOut = requiredOption(options, "secret-out", "<new-file>");
			const input = parseInput(webhookEndpointCreateBodySchema, {
				url: requiredOption(options, "url", "<https-url>"),
				description: description(options),
				eventTypes: eventTypes(options) ?? [],
				enabled: enabled(options) ?? true,
			});
			const key = requestKey(options);
			const by = change(options, env);
			const [instanceKey = ""] = positionals;
			return await disclosingSecret(secretOut, key, instanceKey, () =>
				write(env, dependencies, instanceKey, by, "webhooks.endpoints.create", (service, target) =>
					service.createEndpoint(target.project, {
						url: input.url,
						description: input.description ?? null,
						eventTypes: input.eventTypes,
						enabled: input.enabled,
						actor: `operator:${by.actor}`,
						idempotencyKey: key,
					}),
				),
			);
		}
		case "endpoints update": {
			const { positionals, options } = parseArguments(
				args,
				["url", "event-types", "description", "enabled", ...changeOptions],
				2,
			);
			const input = parseInput(webhookEndpointUpdateBodySchema, {
				url: options.get("url"),
				description: description(options),
				eventTypes: eventTypes(options),
				enabled: enabled(options),
			});
			if (Object.values(input).every((value) => value === undefined))
				throw new CliUsageError("Name a change: --url, --event-types, --description or --enabled.");
			const [instanceKey, endpointId] = positionals.map((value, index) =>
				index === 0 ? value : uuidArgument(value, "endpoint id"),
			);
			return await write(
				env,
				dependencies,
				instanceKey,
				change(options, env),
				"webhooks.endpoints.update",
				(service, target) => service.updateEndpoint(target.project, endpointId, input),
			);
		}
		case "endpoints delete": {
			const { positionals, options } = parseArguments(args, changeOptions, 2);
			const [instanceKey, endpointId] = positionals.map((value, index) =>
				index === 0 ? value : uuidArgument(value, "endpoint id"),
			);
			return await write(
				env,
				dependencies,
				instanceKey,
				change(options, env),
				"webhooks.endpoints.delete",
				async (service, target) => ({
					...(await service.deleteEndpoint(target.project, endpointId)),
					deleted: true,
				}),
			);
		}
		case "endpoints rotate-secret": {
			const { positionals, options } = parseArguments(
				args,
				["secret-out", "overlap-hours", "request-key", ...changeOptions],
				2,
			);
			const secretOut = requiredOption(options, "secret-out", "<new-file>");
			const { overlapHours } = parseInput(webhookSecretRotationBodySchema, {
				overlapHours: wholeNumber(options, "overlap-hours"),
			});
			const key = requestKey(options);
			const [instanceKey, endpointId] = positionals.map((value, index) =>
				index === 0 ? value : uuidArgument(value, "endpoint id"),
			);
			const by = change(options, env);
			return await disclosingSecret(secretOut, key, instanceKey ?? "", () =>
				write(
					env,
					dependencies,
					instanceKey,
					by,
					"webhooks.endpoints.rotate-secret",
					(service, target) =>
						service.rotateSecret(target.project, endpointId, { overlapHours, idempotencyKey: key }),
				),
			);
		}
		case "endpoints test": {
			const { positionals, options } = parseArguments(args, changeOptions, 2);
			const [instanceKey, endpointId] = positionals.map((value, index) =>
				index === 0 ? value : uuidArgument(value, "endpoint id"),
			);
			return await write(
				env,
				dependencies,
				instanceKey,
				change(options, env),
				"webhooks.endpoints.test",
				(service, target) => service.sendTestEvent(target.project, endpointId),
			);
		}
		case "deliveries list": {
			const { positionals, options } = parseArguments(
				args,
				["endpoint", "status", "event-type", "billing-account", "limit", "cursor"],
				1,
			);
			const query = parseInput(webhookDeliveryListQuerySchema, {
				limit: options.get("limit"),
				cursor: options.get("cursor"),
				endpointId: options.get("endpoint"),
				status: options.get("status"),
				eventType: options.get("event-type"),
				billingAccountId: options.get("billing-account"),
			});
			return await read(env, dependencies, positionals[0], async (service, target) => {
				const page = await service.listDeliveries(target.project, {
					limit: query.limit,
					cursor: query.cursor ?? null,
					endpointId: query.endpointId ?? null,
					status: query.status ?? null,
					eventType: query.eventType ?? null,
					billingAccountId: query.billingAccountId ?? null,
				});
				return {
					instance: target.instanceKey,
					deliveries: page.items,
					nextCursor: page.nextCursor,
				};
			});
		}
		case "deliveries retry": {
			const { positionals, options } = parseArguments(args, changeOptions, 2);
			const [instanceKey, deliveryId] = positionals.map((value, index) =>
				index === 0 ? value : uuidArgument(value, "delivery id"),
			);
			return await write(
				env,
				dependencies,
				instanceKey,
				change(options, env),
				"webhooks.deliveries.retry",
				(service, target) => service.retryDelivery(target.project, deliveryId),
			);
		}
		case "deliveries replay": {
			const { positionals, options } = parseArguments(
				args,
				["from", "to", "event-types", ...changeOptions],
				2,
			);
			const input = parseInput(webhookReplayBodySchema, {
				from: requiredOption(options, "from", "<time>"),
				to: requiredOption(options, "to", "<time>"),
				eventTypes: eventTypes(options) ?? [],
			});
			const [instanceKey, endpointId] = positionals.map((value, index) =>
				index === 0 ? value : uuidArgument(value, "endpoint id"),
			);
			return await write(
				env,
				dependencies,
				instanceKey,
				change(options, env),
				"webhooks.endpoints.replay",
				(service, target) =>
					service.replay(target.project, endpointId, {
						from: new Date(input.from),
						to: new Date(input.to),
						eventTypes: input.eventTypes,
					}),
			);
		}
		default:
			throw new CliUsageError(
				command === "" ? "Missing subcommand." : `Unknown subcommand ${JSON.stringify(command)}.`,
			);
	}
}

/** A read names no one and works on every organization, members or not. */
async function read<T>(
	env: Environment,
	dependencies: WebhooksCommandDependencies,
	instanceKey: string | undefined,
	run: (service: WebhookEndpointServiceLike, target: OperatorTarget) => Promise<T>,
): Promise<T> {
	return await withTarget(env, dependencies, instanceKey ?? "", async (context, target) => {
		await context.gate(target, "reader").instance(context.sql, false);
		return await run(context.webhooks, target);
	});
}

/**
 * A change is checked by the operator gate, which admits active and inactive environments of an
 * active organization and needs a reason for one whose members manage it, and is audited as the
 * console audits its own, before it runs.
 */
async function write<T>(
	env: Environment,
	dependencies: WebhooksCommandDependencies,
	instanceKey: string | undefined,
	by: Change,
	operation: string,
	run: (service: WebhookEndpointServiceLike, target: OperatorTarget) => Promise<T>,
): Promise<T> {
	return await withTarget(env, dependencies, instanceKey ?? "", async (context, target) => {
		const gate = context.gate(target, by.actor, { memberOverrideReason: by.reason });
		await gate.instance(context.sql, true);
		await insertPlatformAuditEvent(context.sql, {
			principalId: null,
			organizationId: target.organizationId,
			action: "billing.action_accepted",
			target: target.instanceId,
			metadata: {
				operator: by.actor,
				...(by.reason === undefined ? {} : { memberOverrideReason: by.reason }),
				action: "webhooks.manage",
				operation,
				environment: target.environment,
			},
		});
		return await run(context.webhooks, target);
	});
}

async function withTarget<T>(
	env: Environment,
	dependencies: WebhooksCommandDependencies,
	instanceKey: string,
	run: (context: OperatorContext, target: OperatorTarget) => Promise<T>,
): Promise<T> {
	const context = await openOperatorContext(env, dependencies);
	try {
		const target = await context.target(instanceKey);
		return await run(context, target);
	} catch (error) {
		// A refusal reads as the API's: its code, message and details.
		if (error instanceof BillingError)
			throw new BillingApiError(error.message, error.code, error.status, error.details);
		throw error;
	} finally {
		await context.close();
	}
}

/**
 * Writes a disclosed signing secret to a new owner-only file, never to stdout. The file is reserved
 * before anything is checked or changed, so a path that cannot take it refuses the command first;
 * a repeat of a request whose secret was already disclosed leaves no file.
 */
async function disclosingSecret(
	path: string,
	key: string,
	instanceKey: string,
	run: () => Promise<{
		duplicate: boolean;
		endpoint: { id: string; secretGeneration: number };
		secret: string | null;
	}>,
): Promise<unknown> {
	const file = await reserveSecretFile(path);
	let result: Awaited<ReturnType<typeof run>>;
	try {
		result = await run();
	} catch (error) {
		await file.discard();
		throw error;
	}
	const value = {
		requestKey: key,
		instance: instanceKey,
		duplicate: result.duplicate,
		endpoint: result.endpoint,
		secretOut: result.secret === null ? null : file.path,
	};
	if (result.secret === null) {
		await file.discard();
		return new CommandReport(
			value,
			0,
			"This request key already ran and its secret was disclosed then; rotate the secret to get a new one.",
		);
	}
	try {
		await file.write(
			`${JSON.stringify(
				{
					version: 1,
					endpointId: result.endpoint.id,
					secretGeneration: result.endpoint.secretGeneration,
					webhookSecret: result.secret,
				},
				null,
				2,
			)}\n`,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Endpoint ${result.endpoint.id} has a new secret, but writing it to ${path} failed (${reason}); rotate the secret again to get one.`,
		);
	}
	return value;
}

function uuidArgument(value: string, name: string): string {
	if (!z.uuid().safeParse(value).success) throw new CliUsageError(`The ${name} must be a UUID.`);
	return value;
}

function requiredOption(options: ParsedArguments["options"], name: string, value: string): string {
	const given = options.get(name);
	if (given === undefined) throw new CliUsageError(`--${name} ${value} is required.`);
	return given;
}

/** `--event-types a,b`, or `all` for every type; absent leaves them as they are. */
function eventTypes(options: ParsedArguments["options"]): string[] | undefined {
	const value = options.get("event-types");
	if (value === undefined) return undefined;
	if (value.trim() === "all") return [];
	return value
		.split(",")
		.map((type) => type.trim())
		.filter((type) => type !== "");
}

/** `--description ""` clears it. */
function description(options: ParsedArguments["options"]): string | null | undefined {
	const value = options.get("description");
	if (value === undefined) return undefined;
	return value.trim() === "" ? null : value;
}

function enabled(options: ParsedArguments["options"]): boolean | undefined {
	const value = options.get("enabled");
	if (value === undefined) return undefined;
	if (value !== "true" && value !== "false")
		throw new CliUsageError("--enabled takes true or false.");
	return value === "true";
}

function wholeNumber(options: ParsedArguments["options"], name: string): number | undefined {
	const value = options.get(name);
	if (value === undefined) return undefined;
	if (!/^\d{1,4}$/.test(value)) throw new CliUsageError(`--${name} must be a whole number.`);
	return Number(value);
}

/** The route's own schema, so the command accepts exactly what `/v1` accepts. */
function parseInput<T>(schema: z.ZodType<T>, value: Record<string, unknown>): T {
	const defined = Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	);
	const result = schema.safeParse(defined);
	if (!result.success) {
		const { issues } = result.error;
		throw new BillingApiError(
			describeRequestIssues("Invalid input", requestIssues(null, issues), issues.length),
			"INVALID_REQUEST",
			400,
		);
	}
	return result.data;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runWebhooksCommand(process.argv.slice(2), process.env);
}
