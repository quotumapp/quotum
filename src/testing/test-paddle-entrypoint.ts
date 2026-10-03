import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { registerQuotumProcessShutdown } from "../composition/public-runtime";
import { loadEnv } from "../env";
import { paddleConfigSchema } from "../providers/paddle/config";
import { createBillingRuntime } from "../runtime";
import { fixtureConnections } from "./connection-fixtures";
import { paddlePaymentPage } from "./paddle-payment-page";
import { requirePaddlePreflightEnvironment } from "./paddle-preflight";

const path = requirePaddlePreflightEnvironment(process.env);
const stat = await lstat(path);
if (!stat.isFile() || (stat.mode & 0o077) !== 0)
	throw new Error("Paddle configuration must be an owner-only regular file");
const config = z
	.object({
		projectInstanceKey: z.string().regex(/^[a-z0-9-]+$/),
		connection: paddleConfigSchema,
		connectionVersionId: z.uuid(),
		projectionUrl: z.url(),
		projectionSecret: z.string().min(16),
	})
	.strict()
	.parse(JSON.parse(await readFile(path, "utf8")));
const env = loadEnv();
const runtime = createBillingRuntime(env, {
	merchant: null,
	projectionFetch: globalThis.fetch,
	connections: fixtureConnections([
		{
			projectInstanceKey: config.projectInstanceKey,
			projectionUrl: config.projectionUrl,
			projectionSecret: config.projectionSecret,
			paddle: {
				...config.connection,
				versionId: config.connectionVersionId,
				accountIdentity: `paddle:sandbox:${config.connection.notificationSettingId}`,
			},
		},
	]),
});
registerQuotumProcessShutdown(runtime);
await runtime.start();

// Only this second listener is tunneled. The private API remains bound to loopback.
const publicServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 4319,
	async fetch(request, server) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/pay")
			return new Response(paddlePaymentPage(config.connection.clientToken), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
				},
			});
		if (
			request.method === "POST" &&
			url.pathname === `/v1/projects/${config.projectInstanceKey}/webhooks/paddle`
		)
			return runtime.app.fetch(request, server);
		return new Response("Not found", { status: 404 });
	},
});
process.on("exit", () => publicServer.stop(true));
export default { hostname: "127.0.0.1", port: 4318, fetch: runtime.app.fetch.bind(runtime.app) };
