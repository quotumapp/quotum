import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { loadConnectionCipher } from "../../platform/connections/cipher";
import { MerchantError } from "../../platform/security";
import { SetupFailure, setupCredentialsSchema, setupDiagnostics } from "../stripe-setup/schema";
import { type StripeSetupOptions, StripeSetupService } from "../stripe-setup/service";
import {
	CliUsageError,
	type CommandOutput,
	CommandReport,
	memberOverrideReason,
	openOperatorContext,
	operatorActor,
	parseArguments,
	readSettings,
	readStdin,
	runOperatorCommand,
} from "./operator-context";

/** Open without following symlinks; inspect and read the same descriptor under a strict cap. */
export async function readSetupCredentials(path: string) {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > 64 * 1024 || (metadata.mode & 0o077) !== 0)
			throw new Error("private file required");
		const bytes = Buffer.alloc(64 * 1024 + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead > 64 * 1024) throw new Error("size limit");
		return setupCredentialsSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
	} catch {
		throw new CliUsageError(
			"Credentials must be a private regular JSON file (0600), at most 64 KB, with setupKey, runtimeKey and optional webhookSecret.",
		);
	} finally {
		await handle?.close();
	}
}

/** Exit `0` once a setup is prepared or complete, `2` while a delivery or a review is outstanding. */
function setupReport(result: { status: string }) {
	return new CommandReport(
		result,
		result.status === "complete" || result.status === "prepared" ? 0 : 2,
	);
}

export async function runStripeSetupCommand(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	dependencies: { output?: CommandOutput; client?: StripeSetupOptions["client"] } = {},
) {
	return runOperatorCommand(
		async () => {
			const [command, ...args] = argv;
			if (!["prepare", "apply", "status", "verify"].includes(command ?? ""))
				throw new CliUsageError("Expected prepare, apply, status or verify.");
			const { positionals, options } = parseArguments(
				args,
				["credentials-file", "actor", "member-override-reason"],
				1,
			);
			const source = positionals[0] ?? "";
			if (command !== "prepare" && !z.uuid().safeParse(source).success)
				throw new CliUsageError("Expected a setup UUID.");
			const actor = command === "status" ? "reader" : operatorActor(options, env);
			const credentialsPath = options.get("credentials-file");
			if (command !== "status" && !credentialsPath)
				throw new CliUsageError("--credentials-file is required.");
			const credentials = credentialsPath ? await readSetupCredentials(credentialsPath) : null;
			const cipher = loadConnectionCipher(env);
			const context = await openOperatorContext(env);
			try {
				const service = new StripeSetupService({
					context,
					cipher,
					actor,
					memberOverrideReason: memberOverrideReason(options),
					client: dependencies.client,
				});
				if (command === "status") return setupReport(await service.status(source));
				if (!credentials) throw new CliUsageError("Credentials are required.");
				return setupReport(
					command === "prepare"
						? await service.prepare(await readSettings(source, readStdin), credentials)
						: await service.apply(source, credentials, command === "verify"),
				);
			} catch (error) {
				if (error instanceof CliUsageError) throw error;
				// One `CODE: reason` line; the reason is a fixed vocabulary, never provider text.
				if (error instanceof SetupFailure)
					throw new MerchantError("STRIPE_SETUP_FAILED", error.reason, 409);
				if (error instanceof MerchantError) {
					const checks = setupDiagnostics(error);
					throw new CliUsageError(checks ? `${error.code}: ${JSON.stringify(checks)}` : error.code);
				}
				throw new Error(
					"Stripe setup failed. Check the manifest, account access and permission recipe; inspect status before retrying.",
				);
			} finally {
				await context.close();
			}
		},
		"quotum setup stripe --help",
		dependencies.output,
	);
}

if (import.meta.main)
	process.exitCode = await runStripeSetupCommand(process.argv.slice(2), process.env);
