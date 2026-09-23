import type { Elysia } from "elysia";
import { createConnectionEventApp } from "../../src/composition/connection-events";
import { buildDocumentedApps } from "../../src/composition/openapi";
import { createRemoteMcpApp } from "../../src/composition/remote-mcp";
import { createStripeAppEvents } from "../../src/composition/stripe-app-events";

/** Every registered route table: the documented staff and merchant apps plus the ingress apps. */
export function routeTables(): readonly Elysia[] {
	// Registration-only stubs: the ingress apps are built but never receive a request here.
	const repository = { executor: {} } as never;
	return [
		...buildDocumentedApps(),
		createRemoteMcpApp({
			auth: {} as never,
			store: {
				config: {
					mcp: { origin: "https://api.quotum.invalid" },
					origin: "https://app.quotum.invalid",
				},
			} as never,
			port: {} as never,
		}) as unknown as Elysia,
		createConnectionEventApp(repository) as unknown as Elysia,
		createStripeAppEvents(repository, {} as never, {} as never).app as unknown as Elysia,
	];
}
