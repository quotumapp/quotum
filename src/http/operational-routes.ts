import { z } from "zod";
import type { BillingElysia } from "../app/types";
import { operationDetail } from "../shared/http";

const okSchema = z.object({ status: z.literal("ok") });
const unavailableSchema = z.object({ status: z.literal("unavailable") });

export function registerOperationalRoutes(input: {
	app: BillingElysia;
	readinessCheck: () => boolean | Promise<boolean>;
	renderMetrics: () => Promise<string>;
}): void {
	const { app, readinessCheck, renderMetrics } = input;

	app.get("/health", () => ({ status: "ok" }), {
		detail: operationDetail({
			operationId: "getHealth",
			tags: ["operations"],
			path: "/health",
			responses: { 200: okSchema },
		}),
	});

	app.get("/livez", () => ({ status: "ok" }), {
		detail: operationDetail({
			operationId: "getLivez",
			tags: ["operations"],
			path: "/livez",
			responses: { 200: okSchema },
		}),
	});

	app.get(
		"/ready",
		async ({ set }) => {
			if (await readinessCheck()) {
				return { status: "ok" as const };
			}
			set.status = 503;
			return { status: "unavailable" as const };
		},
		{
			detail: operationDetail({
				operationId: "getReady",
				tags: ["operations"],
				path: "/ready",
				responses: { 200: okSchema, 503: unavailableSchema },
			}),
		},
	);

	app.get(
		"/metrics",
		async () =>
			new Response(await renderMetrics(), {
				headers: { "content-type": "text/plain; version=0.0.4" },
			}),
		{
			detail: operationDetail({
				operationId: "getMetrics",
				tags: ["operations"],
				path: "/metrics",
				responses: { 200: z.string() },
				contentType: "text/plain",
			}),
		},
	);
}
