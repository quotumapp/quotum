import { z } from "@hono/zod-openapi";
import { defineContract } from "../shared/http-contract";

const ok = z.object({ status: z.literal("ok") });
export const operationalContracts = {
	health: defineContract("get", "/health", {
		operationId: "getHealth",
		tags: ["operations"],
		responses: { 200: ok },
	}),
	livez: defineContract("get", "/livez", {
		operationId: "getLivez",
		tags: ["operations"],
		responses: { 200: ok },
	}),
	ready: defineContract("get", "/ready", {
		operationId: "getReady",
		tags: ["operations"],
		responses: { 200: ok, 503: z.object({ status: z.literal("unavailable") }) },
	}),
	metrics: defineContract("get", "/metrics", {
		operationId: "getMetrics",
		tags: ["operations"],
		responses: { 200: z.string() },
		contentType: "text/plain",
	}),
};
