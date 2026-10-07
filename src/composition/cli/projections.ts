import { randomUUID } from "node:crypto";
import { parseProjectionReceivers } from "../../env";
import { createProjectionSignatureHeaders } from "../../projections/http-types";
import {
	type DestinationPostDependencies,
	postToDestination,
	publicDestinationPolicy,
} from "../../shared/safe-http";
import { projectionDestinationPolicy } from "../projection-destinations";
import {
	CliUsageError,
	type CommandOutput,
	parseArguments,
	readStdin,
	runOperatorCommand,
} from "./operator-context";

export async function checkReceiver(
	urlText: string,
	projectKey: string,
	secret: string,
	dependencies: DestinationPostDependencies = { policy: publicDestinationPolicy },
) {
	const url = new URL(urlText);
	if (url.username || url.password || url.search || url.hash)
		throw new CliUsageError("Use a receiver base URL without credentials, query or fragment.");
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/internal/billing/projections/verify`;
	const checks = [];
	for (const check of [
		"valid_challenge",
		"wrong_bearer",
		"invalid_signature",
		"expired_timestamp",
	] as const) {
		const challenge = randomUUID();
		const body = JSON.stringify({ challenge, projectKey });
		const headers = {
			authorization: `Bearer ${check === "wrong_bearer" ? randomUUID() : secret}`,
			"content-type": "application/json",
			...createProjectionSignatureHeaders({
				secret: check === "invalid_signature" ? randomUUID() : secret,
				body,
				now: () => new Date(Date.now() - (check === "expired_timestamp" ? 600_000 : 0)),
			}),
		};
		try {
			const response = await postToDestination(url.toString(), body, headers, dependencies);
			let ack: unknown;
			try {
				ack = JSON.parse(response.body);
			} catch {
				ack = null;
			}
			const valid =
				typeof ack === "object" &&
				ack !== null &&
				"success" in ack &&
				ack.success === true &&
				"challenge" in ack &&
				ack.challenge === challenge &&
				Object.keys(ack).length === 2;
			const passed =
				check === "valid_challenge"
					? response.status === 200 && valid
					: response.status === 401 || response.status === 403;
			checks.push({
				check,
				passed,
				httpStatus: response.status,
				reason: passed ? "passed" : "unexpected_response",
			});
		} catch {
			checks.push({ check, passed: false, reason: "receiver_unreachable_or_disallowed" });
		}
	}
	return { success: checks.every((check) => check.passed), checks };
}

export async function runProjectionsCommand(
	argv: readonly string[],
	output?: CommandOutput,
): Promise<number> {
	let passed = false;
	const code = await runOperatorCommand(
		async () => {
			if (argv[0] !== "check-receiver") throw new CliUsageError("Expected check-receiver.");
			const { positionals, options } = parseArguments(
				argv.slice(1),
				["project-key", "secret-file"],
				1,
			);
			const projectKey = options.get("project-key");
			const file = options.get("secret-file");
			if (!projectKey || !file)
				throw new CliUsageError("--project-key and --secret-file are required.");
			const secret = (
				file === "-" ? new TextDecoder().decode(await readStdin()) : await Bun.file(file).text()
			).trim();
			if (!secret) throw new CliUsageError("The secret file is empty.");
			const projectionReceivers = parseProjectionReceivers(
				process.env.BILLING_PROJECTION_ALLOWED_NETWORKS,
				process.env.BILLING_PROJECTION_ALLOW_INSECURE_HTTP === "true",
			);
			const result = await checkReceiver(positionals[0] ?? "", projectKey, secret, {
				policy: projectionDestinationPolicy(
					{ ...(projectionReceivers === undefined ? {} : { projectionReceivers }) },
					process.env.QUOTUM_MERCHANT_ENABLED !== "false",
				),
			});
			passed = result.success;
			return result;
		},
		"quotum projections --help",
		output,
	);
	return code || (passed ? 0 : 1);
}
if (import.meta.main) process.exitCode = await runProjectionsCommand(process.argv.slice(2));
