import { OpenAPIHono } from "@hono/zod-openapi";
import { adminContracts } from "../app/admin-routes";
import { catalogContracts } from "../app/catalog-routes";
import { controlsContracts } from "../app/controls-routes";
import { customerContracts } from "../app/customer-routes";
import { insightsContracts } from "../app/insights-routes";
import { meteringContracts } from "../app/metering-routes";
import { webhookContracts } from "../app/webhook-routes";
import { operationalContracts } from "../http/operational-contracts";
import { platformContracts } from "../platform/app";
import * as platformSchemas from "../platform/schemas";
import { generateAuthOpenApi } from "./auth-openapi";
import { merchantBillingContracts } from "./merchant-openapi";

export const httpContracts = [
	...Object.values(adminContracts),
	...Object.values(catalogContracts),
	...Object.values(controlsContracts),
	...Object.values(customerContracts),
	...Object.values(insightsContracts),
	...Object.values(meteringContracts),
	...Object.values(webhookContracts),
	...Object.values(operationalContracts),
	...Object.values(platformContracts),
];

export async function generateOpenApi(version: string) {
	const app = new OpenAPIHono();
	const registry = app.openAPIRegistry;
	registry.registerComponent("securitySchemes", "projectKey", {
		type: "http",
		scheme: "bearer",
		description: "Project-environment API credential; trusted backends only.",
	});
	registry.registerComponent("securitySchemes", "gatewayProject", {
		type: "apiKey",
		in: "header",
		name: "X-Billing-Project-Key",
		description: "Only accepted from the configured trusted gateway.",
	});
	registry.registerComponent("securitySchemes", "merchantSession", {
		type: "apiKey",
		in: "cookie",
		name: "__Host-quotum_session",
	});
	registry.registerComponent("securitySchemes", "serviceToken", {
		type: "apiKey",
		in: "header",
		name: "X-Quotum-Service-Token",
		description: "Added by the server-side BFF, never a browser credential.",
	});
	registry.registerComponent("securitySchemes", "operatorKey", {
		type: "apiKey",
		in: "header",
		name: "X-Billing-Operator-Key",
	});
	registry.registerComponent("securitySchemes", "stripeSignature", {
		type: "apiKey",
		in: "header",
		name: "Stripe-Signature",
	});
	registry.registerComponent("securitySchemes", "googleOidc", {
		type: "http",
		scheme: "bearer",
		bearerFormat: "JWT",
	});
	for (const [name, schema] of Object.entries(platformSchemas))
		registry.register(name.replace(/Schema$/, ""), schema);
	for (const contract of [...httpContracts, ...merchantBillingContracts(httpContracts)])
		registry.registerPath(contract.route);
	const document = app.getOpenAPI31Document({
		openapi: "3.1.0",
		info: {
			title: "Quotum API",
			version,
			description: "Complete implemented HTTP contract. Pre-GA; no stable v1 guarantee is implied.",
		},
	});
	const auth = await generateAuthOpenApi();
	for (const [path, operation] of Object.entries(auth.paths ?? {})) {
		if (document.paths?.[path]) throw new Error(`Duplicate auth path: ${path}`);
		document.paths = { ...document.paths, [path]: operation };
	}
	for (const [name, schema] of Object.entries(auth.components?.schemas ?? {})) {
		if (document.components?.schemas?.[name]) throw new Error(`Duplicate auth schema: ${name}`);
		document.components = {
			...document.components,
			schemas: { ...document.components?.schemas, [name]: schema },
		};
	}

	document.servers = [
		{
			url: "/",
			description:
				"Relative to the configured API origin; merchant paths are accessed through the BFF.",
		},
	];
	const tags = new Set<string>();
	for (const [path, item] of Object.entries(document.paths ?? {}))
		for (const method of ["get", "post", "put", "delete", "patch"] as const) {
			const operation = item?.[method];
			if (!operation) continue;
			operation.summary ??= `${method.toUpperCase()} ${path}`;
			for (const tag of operation.tags ?? []) tags.add(tag);
		}
	document.tags = [...tags]
		.sort()
		.map((name) => ({ name, description: `Implemented ${name} operations.` }));
	return document;
}
