import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { diagnosticParameters, diagnosticQuery } from "../helpers/database-diagnostic";

// Use the real linked-error and logging integrations, without sending any telemetry over the wire.
const probe = `
import * as Sentry from "@sentry/bun";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createPinoBillingLogger } from "./src/observability/logger";
import { initializeSentry, createSentryBillingLogger } from "./src/observability/sentry";
import { databaseFailure, diagnosticParameters, diagnosticQuery } from "./tests/helpers/database-diagnostic";
const envelopes = [];
const lines = [];
const config = {
	dsn: "https://public@sentry.example/123", environment: "test", release: null,
	enableLogs: true, tracesSampleRate: 0, logLevel: "warn", captureExpectedErrors: false,
};
initializeSentry({ init: (options) => Sentry.init({
	...options,
	transport: () => ({
		send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
		flush: async () => true,
	}),
}) }, config);
const baseLogger = createPinoBillingLogger({ destination: { write: line => lines.push(line) } });
const logger = createSentryBillingLogger({ baseLogger, sentry: Sentry, config });
const error = databaseFailure();
const originalStack = error.stack;
logger.error("Worker failed", new Error(error.message, { cause: error }), {
	requestId: "request-1", jobId: "job-1", worker: "projection_sync", projectKey: "acme",
	email: diagnosticParameters[0], query: diagnosticQuery, params: diagnosticParameters,
	nested: { message: error.message, error },
});
const silent = createSentryBillingLogger({
	baseLogger: createPinoBillingLogger({ level: "silent", destination: { write: line => lines.push(line) } }),
	sentry: Sentry, config,
});
silent.error("Silent worker failed", databaseFailure("23505"), { jobId: "job-2" });
Sentry.addBreadcrumb({ category: "database", message: error.message, data: { query: diagnosticQuery, params: diagnosticParameters } });
Sentry.captureException(databaseFailure());
const injected = new DrizzleQueryError(diagnosticQuery, ["private multiline value\\n    at stolen (/tmp/parameter-value.ts:7:9)"], databaseFailure());
Sentry.captureException(injected);
Sentry.logger.error(error.message, { query: diagnosticQuery, params: diagnosticParameters });
const disabled = createSentryBillingLogger({ baseLogger, sentry: Sentry, config: { ...config, dsn: null } });
disabled.error("Local only", databaseFailure(), { requestId: "request-2", email: diagnosticParameters[0] });
await Sentry.close(2000);
process.stdout.write(JSON.stringify({ lines, envelopes, errorUnchanged: error.stack === originalStack && error.params === diagnosticParameters }));
`;

it("removes database values from real Sentry envelopes and local output while retaining source frames and correlation", async () => {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", probe], {
		cwd: resolve(import.meta.dir, "../.."),
		env: createSanitizedProcessEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	for (const marker of [diagnosticQuery, ...diagnosticParameters])
		expect(stdout).not.toContain(marker);
	expect(stdout).not.toContain("private multiline value");
	expect(stdout).not.toContain("parameter-value.ts");
	const output = JSON.parse(stdout) as {
		lines: string[];
		envelopes: Array<[unknown, Array<[{ type: string }, Record<string, unknown>]>]>;
		errorUnchanged: boolean;
	};
	expect(output.errorUnchanged).toBe(true);
	expect(output.lines).toHaveLength(2);
	expect(JSON.parse(output.lines[0] ?? "")).toMatchObject({
		context: {
			requestId: "request-1",
			jobId: "job-1",
			worker: "projection_sync",
			projectKey: "acme",
		},
		err: { sqlState: "40P01", constraint: "customers_project_id_id_unique" },
	});
	const items = output.envelopes.flatMap((envelope) => envelope[1]);
	const events = items.filter(([header]) => header.type === "event").map(([, event]) => event);
	expect(events).toHaveLength(4);
	for (const event of events) {
		const exception = event.exception as {
			values: Array<{ value: string; stacktrace?: { frames: unknown[] } }>;
		};
		expect(exception.values.length).toBeGreaterThan(0);
		for (const value of exception.values) {
			expect(value.value).toBe("Database operation failed");
			expect(value.stacktrace?.frames.length).toBeGreaterThan(0);
		}
		expect(event.contexts).toMatchObject({
			database: { constraint: "customers_project_id_id_unique" },
		});
	}
	const logs = items.filter(([header]) => header.type === "log");
	expect(logs.length).toBeGreaterThan(0);
	expect(JSON.stringify(logs)).toContain("error.sql_state");
	expect(JSON.stringify(events)).toContain("request-1");
	expect(JSON.stringify(events)).toContain("job-2");
}, 20_000);
