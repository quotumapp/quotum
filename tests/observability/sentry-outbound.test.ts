import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";

const repositoryRoot = resolve(import.meta.dir, "../..");

// The SDK patches the global fetch and node:http, so it runs in its own process.
const probe = `
import { get } from "node:http";
import * as Sentry from "@sentry/bun";
import { initializeSentry } from "./src/observability/sentry";

const received = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const headers = [...request.headers.keys()].filter((name) =>
			/sentry|baggage|traceparent/i.test(name),
		);
		received.push({ path: new URL(request.url).pathname, headers });
		return new Response("ok");
	},
});
const envelopes = [];
initializeSentry(
	{
		init: (options) =>
			Sentry.init({
				...options,
				transport: () => ({
					send: async (envelope) => {
						envelopes.push(envelope);
						return { statusCode: 200 };
					},
					flush: async () => true,
				}),
			}),
	},
	{
		dsn: "https://public@sentry.example/123",
		environment: "production",
		release: "quotum-api@1.2.3",
		enableLogs: false,
		tracesSampleRate: 1,
		logLevel: "error",
		captureExpectedErrors: false,
	},
);
const base = "http://127.0.0.1:" + server.port;
await (await fetch(base + "/fetch?token=query-secret#fragment-secret")).text();
await new Promise((done) =>
	get(base + "/node-http?token=query-secret#fragment-secret", (response) => {
		response.resume();
		response.on("end", done);
	}),
);
Sentry.captureException(new Error("probe"));
await Sentry.flush(2000);
server.stop(true);
const event = envelopes
	.flatMap((envelope) => envelope[1])
	.find(([header]) => header.type === "event")?.[1];
process.stdout.write(JSON.stringify({ received, breadcrumbs: event?.breadcrumbs ?? null }));
`;

it("adds no trace headers to outbound requests and keeps their fragments out of breadcrumbs", async () => {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", probe], {
		cwd: repositoryRoot,
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
	const result = JSON.parse(stdout) as {
		received: Array<{ path: string; headers: string[] }>;
		breadcrumbs: Array<{ category?: string; data?: Record<string, unknown> }> | null;
	};
	expect(result.received).toEqual([
		{ path: "/fetch", headers: [] },
		{ path: "/node-http", headers: [] },
	]);
	const outbound = (result.breadcrumbs ?? []).filter((breadcrumb) =>
		["fetch", "http"].includes(breadcrumb.category ?? ""),
	);
	expect(outbound.map((breadcrumb) => breadcrumb.category)).toEqual(["fetch", "http"]);
	expect(JSON.stringify(outbound)).not.toContain("secret");
}, 20_000);
