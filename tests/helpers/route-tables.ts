import type { Elysia } from "elysia";
import { createConnectionEventApp } from "../../src/composition/connection-events";
import { buildDocumentedApps } from "../../src/composition/openapi";
import { createStripeAppEvents } from "../../src/composition/stripe-app-events";

/** Every registered route table: the documented staff and merchant apps plus the ingress apps. */
export function routeTables(): readonly Elysia[] {
	// Registration-only stubs: the ingress apps are built but never receive a request here.
	const repository = { sql: {} } as never;
	return [
		...buildDocumentedApps(),
		createConnectionEventApp(repository) as unknown as Elysia,
		createStripeAppEvents(repository, {} as never).app as unknown as Elysia,
	];
}
