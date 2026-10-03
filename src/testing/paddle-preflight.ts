import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { paddlePriceBindingSchema } from "../providers/paddle/catalog";
import { PaddleClient, type PaddleFetch } from "../providers/paddle/client";
import { paddleConfigSchema } from "../providers/paddle/config";
import { validatePaddleConnection } from "../providers/paddle/connection";
import { PaddleGateway } from "../providers/paddle/gateway";
import { writeStderr, writeStdout } from "../shared/cli-output";

const preflightSchema = z
	.object({
		connection: paddleConfigSchema,
		webhookUrl: z
			.url()
			.refine((value) => URL.canParse(value) && new URL(value).protocol === "https:"),
		bindings: z.array(paddlePriceBindingSchema).min(1),
	})
	.strict();

/** Read-only preparation for qualification; it does not create transactions or certify support. */
export async function runPaddlePreflight(input: unknown, fetcher: PaddleFetch = fetch) {
	const parsed = preflightSchema.parse(input);
	const client = new PaddleClient(parsed.connection, fetcher);
	const identity = await validatePaddleConnection({
		client,
		config: parsed.connection,
		webhookUrl: parsed.webhookUrl,
	});
	const gateway = new PaddleGateway(client, parsed.connection);
	// Different entries may intentionally qualify different products and billing intervals.
	for (const binding of parsed.bindings) await gateway.validatePrices([binding]);
	return {
		schemaVersion: 1,
		environment: "sandbox",
		status: "preflight_passed",
		qualification: "pending",
		accountAnchor: identity.accountAnchor,
		validatedPriceIds: parsed.bindings.map((binding) => binding.priceId),
		checkedAt: new Date().toISOString(),
	} as const;
}

export function requirePaddlePreflightEnvironment(env: Record<string, string | undefined>): string {
	if (
		env.BILLING_ENV !== "test" ||
		env.BILLING_TEST_PADDLE_SANDBOX !== "true" ||
		!env.BILLING_TEST_PADDLE_CONFIG_FILE
	) {
		throw new Error(
			"Paddle preflight requires BILLING_ENV=test, BILLING_TEST_PADDLE_SANDBOX=true and BILLING_TEST_PADDLE_CONFIG_FILE",
		);
	}
	return env.BILLING_TEST_PADDLE_CONFIG_FILE;
}

if (import.meta.main) {
	try {
		const path = requirePaddlePreflightEnvironment(process.env);
		const info = await lstat(path);
		if (!info.isFile() || (info.mode & 0o077) !== 0)
			throw new Error("Paddle configuration must be an owner-only regular file");
		const result = await runPaddlePreflight(JSON.parse(await readFile(path, "utf8")));
		writeStdout(JSON.stringify(result, null, 2));
	} catch {
		// Config validation and provider errors can contain credentials or customer data.
		writeStderr(
			"Paddle preflight failed. Check the test guards, private configuration, sandbox permissions, notification setting and price bindings.",
		);
		process.exitCode = 1;
	}
}
