import type { ConnectionKind } from "../../platform/connections/repository";
import { MerchantError } from "../../platform/security";
import {
	CliUsageError,
	type CommandOutput,
	type OperatorContext,
	type OperatorContextDependencies,
	openOperatorContext,
	operatorActor,
	parseArguments,
	readSecrets,
	readSettings,
	readStdin,
	requestKey,
	reserveSecretFile,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ConnectionsCommandDependencies extends OperatorContextDependencies {
	stdin?: () => Promise<Uint8Array>;
	output?: CommandOutput;
	/** How long `commit --wait-for-event` sleeps between checks. */
	pollIntervalMs?: number;
}

const kinds: readonly ConnectionKind[] = ["stripe", "apple", "google", "projection"];
const providers = new Set<ConnectionKind>(["stripe", "apple", "google"]);

export async function runConnectionsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: ConnectionsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => connectionsCommand(argv, env, dependencies),
		"quotum connections --help",
		dependencies.output,
	);
}

async function connectionsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: ConnectionsCommandDependencies,
): Promise<unknown> {
	const [subcommand, ...args] = argv;
	const stdin = dependencies.stdin ?? readStdin;
	switch (subcommand) {
		case "list": {
			const { positionals } = parseArguments(args, [], 1);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(positionals[0] ?? "");
				const { connections } = await context.lifecycle.list(context.gate(target, "reader"));
				return {
					instance: target.instanceKey,
					environment: target.environment,
					connections: connections.map((row) => ({
						kind: row.kind,
						connectionId: row.id,
						revision: row.revision,
						enabled: row.enabled,
						activeVersionId: row.active_version_id,
						settings: row.settings,
						validatedAt: row.validated_at,
						eventVerifiedAt: row.event_verified_at,
					})),
				};
			});
		}
		case "draft": {
			const { positionals, options } = parseArguments(
				args,
				["settings", "secrets-file", "secret-out", "expected-revision", "request-key", "actor"],
				2,
			);
			const [instanceKey = "", kindText = ""] = positionals;
			const kind = connectionKind(kindText);
			const settingsPath = options.get("settings");
			if (settingsPath === undefined || settingsPath === "-")
				throw new CliUsageError("--settings <file> is required.");
			const secretsSource = options.get("secrets-file");
			const secretOut = options.get("secret-out");
			if (kind === "projection" && secretsSource !== undefined)
				throw new CliUsageError("Quotum generates the projection secret; omit --secrets-file.");
			if (kind === "projection" && secretOut === undefined)
				throw new CliUsageError("A projection draft needs --secret-out <new-file>.");
			if (kind !== "projection" && secretOut !== undefined)
				throw new CliUsageError("--secret-out applies to projection drafts only.");
			const expectedRevision = optionalRevision(options.get("expected-revision"));
			const key = requestKey(options);
			const actor = operatorActor(options, env);
			const settings = await readSettings(settingsPath, stdin);
			const secrets = secretsSource === undefined ? {} : await readSecrets(secretsSource, stdin);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(instanceKey);
				const gate = context.gate(target, actor);
				const revision =
					expectedRevision ??
					(await context.lifecycle.list(gate)).connections.find((row) => row.kind === kind)
						?.revision ??
					0;
				const file = secretOut === undefined ? undefined : await reserveSecretFile(secretOut);
				try {
					// The secret is written inside the draft's transaction, so a file that cannot be
					// written rolls the draft back instead of leaving one whose secret is lost.
					const draft = await context.lifecycle.draft(
						gate,
						kind,
						key,
						{ settings, secrets, expectedRevision: revision },
						file === undefined
							? undefined
							: (secret) =>
									file.write(
										`${JSON.stringify({ version: 1, projectionSecret: secret }, null, 2)}\n`,
									),
					);
					// A replay returns the stored draft, which never holds the secret.
					if (!draft.secretDisclosed) await file?.discard();
					return {
						requestKey: key,
						instance: target.instanceKey,
						kind,
						draftId: draft.draftId,
						expectedRevision: revision,
						...(file === undefined ? {} : { secretOut: draft.secretDisclosed ? file.path : null }),
						...(providers.has(kind)
							? {
									setupWebhookPath: `/v1/projects/${target.instanceKey}/connections/${draft.draftId}/webhooks/${kind}`,
								}
							: {}),
					};
				} catch (error) {
					await file?.discard();
					throw error;
				}
			});
		}
		case "validate": {
			const { positionals, options } = parseArguments(args, ["actor"], 3);
			const [instanceKey = "", kindText = "", draftId = ""] = positionals;
			const kind = connectionKind(kindText);
			const actor = operatorActor(options, env);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(instanceKey);
				return await context.lifecycle.validate(context.gate(target, actor), kind, draftId);
			});
		}
		case "commit": {
			const { positionals, options } = parseArguments(
				args,
				["wait-for-event", "request-key", "actor"],
				3,
			);
			const [instanceKey = "", kindText = "", draftId = ""] = positionals;
			const kind = connectionKind(kindText);
			const waitMs = waitDuration(options.get("wait-for-event"));
			const key = requestKey(options);
			const actor = operatorActor(options, env);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(instanceKey);
				const gate = context.gate(target, actor);
				// Validation stays fresh for fifteen minutes, so commit always verifies again first.
				await context.lifecycle.validate(gate, kind, draftId);
				if (waitMs > 0 && providers.has(kind)) {
					await waitForProviderEvent(
						context,
						target.instanceId,
						draftId,
						waitMs,
						dependencies.pollIntervalMs ?? 5000,
					);
					// The wait can outlast that window; validating again keeps the event just recorded.
					await context.lifecycle.validate(gate, kind, draftId);
				}
				try {
					return {
						requestKey: key,
						...(await context.lifecycle.commit(gate, kind, draftId, key)),
					};
				} catch (error) {
					if (error instanceof MerchantError && error.code === "PROVIDER_EVENT_REQUIRED")
						throw new MerchantError(
							error.code,
							`${error.message} Send a test event to /v1/projects/${target.instanceKey}/connections/${draftId}/webhooks/${kind}, or rerun with --wait-for-event 10m.`,
							error.status,
						);
					throw error;
				}
			});
		}
		case "disable": {
			const { positionals, options } = parseArguments(
				args,
				["expected-revision", "request-key", "actor"],
				2,
			);
			const [instanceKey = "", kindText = ""] = positionals;
			const kind = connectionKind(kindText);
			const revision = optionalRevision(options.get("expected-revision"));
			if (revision === undefined)
				throw new CliUsageError("--expected-revision <n> is required; see `connections list`.");
			const key = requestKey(options);
			const actor = operatorActor(options, env);
			return await withContext(env, dependencies, async (context) => {
				const target = await context.target(instanceKey);
				return {
					requestKey: key,
					...(await context.lifecycle.disable(context.gate(target, actor), kind, key, revision)),
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

function connectionKind(value: string): ConnectionKind {
	const kind = kinds.find((candidate) => candidate === value);
	if (kind === undefined) throw new CliUsageError(`The kind must be one of ${kinds.join(", ")}.`);
	return kind;
}

function optionalRevision(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d{1,9}$/.test(value))
		throw new CliUsageError("--expected-revision must be a whole number.");
	return Number(value);
}

/** `90s` or `10m`, up to thirty minutes. */
function waitDuration(value: string | undefined): number {
	if (value === undefined) return 0;
	const match = /^(\d{1,4})(s|m)$/.exec(value);
	const ms = match ? Number(match[1]) * (match[2] === "m" ? 60_000 : 1000) : Number.NaN;
	if (!(ms > 0 && ms <= 30 * 60_000))
		throw new CliUsageError("--wait-for-event takes a duration such as 90s or 10m, up to 30m.");
	return ms;
}

async function waitForProviderEvent(
	context: OperatorContext,
	instanceId: string,
	draftId: string,
	waitMs: number,
	pollIntervalMs: number,
): Promise<void> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const version = await context.repository.version(instanceId, draftId);
		if (version.event_verified_at !== null) return;
		if (Date.now() >= deadline) return;
		await Bun.sleep(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
	}
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runConnectionsCommand(process.argv.slice(2), process.env);
}
