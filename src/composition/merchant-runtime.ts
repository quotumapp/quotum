import type { BetterAuthOptions } from "better-auth";
import { Elysia } from "elysia";
import { sql } from "../db/client";
import { attachRequestServer } from "../http/server";
import { createMerchantApp, type MerchantUnexpectedErrorReport } from "../platform/app";
import type { MerchantBillingPort } from "../platform/application/billing-port";
import { createMerchantAuth, type MerchantAuth } from "../platform/auth";
import { createMerchantBilling } from "../platform/billing";
import type { MerchantConfig } from "../platform/config";
import { MerchantStripeOAuth } from "../platform/connections/oauth";
import { MerchantConnections } from "../platform/connections/service";
import { createMerchantMailer, type MerchantMailer } from "../platform/email";
import { MerchantStore } from "../platform/store";
import { type AppElysia, type ElysiaPluginLike, HTTP_APP_CONFIG } from "../shared/http";
import { createConnectionEventApp } from "./connection-events";
import { createConnectionValidation } from "./connection-validation";
import { createConnectionRepository } from "./connections";
import { createEnvironmentBillingPort } from "./environment-billing";
import { merchantAuthDatabase, merchantSql } from "./merchant-persistence";
import { createRemoteMcpApp, type McpUnexpectedErrorReport } from "./remote-mcp";
import type { QuotumApp } from "./runtime-lifecycle";
import { createStripeAppEvents } from "./stripe-app-events";
import { createStripeOAuthPort } from "./stripe-oauth";

/** Wraps one dispatch, e.g. in the Sentry isolation scope the app's hooks tag. */
export interface RequestScope {
	run<T>(request: Request, dispatch: () => T): T;
}

/** A request scope plus the hooks that tag it, installed on the merchant app. */
export interface MerchantRequestScope extends RequestScope {
	plugin: ElysiaPluginLike;
}

export interface MerchantRuntimeOptions {
	onMcpUnexpectedError?: (error: unknown, report: McpUnexpectedErrorReport) => void;
	registerBackground?: (worker: { runOnce(): Promise<void> }) => void;
	config?: MerchantConfig;
	mailer?: MerchantMailer;
	createAuth?: (
		store: MerchantStore,
		mailer: MerchantMailer,
		database: BetterAuthOptions["database"],
	) => MerchantAuth;
}
export function attachMerchantRuntime(
	staff: Elysia,
	billing: MerchantBillingPort,
	options: MerchantRuntimeOptions & {
		config: MerchantConfig;
		staffRequestScope?: RequestScope;
		merchantRequestScope?: MerchantRequestScope;
		mcpRequestScope?: MerchantRequestScope;
		onMerchantUnexpectedError?: (error: unknown, report: MerchantUnexpectedErrorReport) => void;
	},
): QuotumApp {
	const { config } = options;
	const persistence = merchantSql(sql);
	const store = new MerchantStore(persistence, config);
	const mailer = options.mailer ?? (config.email ? createMerchantMailer(config.email) : null);
	if (!mailer)
		throw new Error("Merchant email transport is required; tests must inject a capture mailer");
	const database = merchantAuthDatabase(sql);
	const repository = createConnectionRepository(persistence);
	const validator = createConnectionValidation();
	const oauth = createStripeOAuthPort();
	const connections = new MerchantConnections(
		store,
		repository,
		validator,
		createEnvironmentBillingPort(),
		oauth,
	);
	const auth = (options.createAuth ?? createMerchantAuth)(store, mailer, database);
	const merchant = createMerchantApp({
		store,
		connections,
		stripeOAuth: oauth
			? new MerchantStripeOAuth(store, connections, repository, oauth, validator)
			: undefined,
		mailer,
		auth,
		billing: createMerchantBilling(store, billing),
		requestObservabilityMiddleware: options.merchantRequestScope?.plugin,
		onUnexpectedError: options.onMerchantUnexpectedError,
	});
	const ingress = [createConnectionEventApp(repository)];
	const remoteMcp = config.mcp
		? createRemoteMcpApp({
				auth,
				store,
				port: billing,
				requestObservabilityMiddleware: options.mcpRequestScope?.plugin,
				onUnexpectedError: options.onMcpUnexpectedError,
			})
		: undefined;
	if (oauth) {
		const events = createStripeAppEvents(repository, oauth, persistence);
		ingress.push(events.app);
		options.registerBackground?.(events);
	}
	return composeRuntimeApp({
		staff,
		merchant,
		ingress,
		remoteMcp,
		mcpRequestScope: options.mcpRequestScope,
		staffRequestScope: options.staffRequestScope,
		merchantRequestScope: options.merchantRequestScope,
	});
}

/** A separately composed app that receives whole requests. */
interface DispatchTarget {
	server: unknown;
	fetch(request: Request): Response | Promise<Response>;
}

/**
 * One process serves the setup-only ingress routes, `/api/*` through the merchant platform and
 * everything else through the staff API. The staff and merchant apps are separate Elysia
 * instances, so Bun's server is attached to each before dispatch; otherwise their client-IP
 * limiters would all share the "unknown" bucket.
 */
export function composeRuntimeApp(input: {
	staff: DispatchTarget;
	merchant: DispatchTarget;
	ingress?: readonly AppElysia[];
	remoteMcp?: DispatchTarget;
	mcpRequestScope?: RequestScope;
	staffRequestScope?: RequestScope;
	merchantRequestScope?: RequestScope;
}): QuotumApp {
	const { staff, merchant, staffRequestScope, merchantRequestScope } = input;
	const app = new Elysia(HTTP_APP_CONFIG);
	for (const ingress of input.ingress ?? []) app.use(ingress);
	// Request hooks are global when mounted with use(). Dispatch MCP separately so its
	// public Host/Origin checks and limiter never run on staff, merchant or health routes.
	if (input.remoteMcp) {
		const remoteMcp = input.remoteMcp;
		for (const path of [
			"/mcp",
			"/oauth/token",
			"/oauth/revoke",
			"/oauth/jwks",
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
		])
			app.all(
				path,
				({ request, server }) => {
					attachRequestServer(remoteMcp, server);
					return input.mcpRequestScope
						? input.mcpRequestScope.run(request, () => remoteMcp.fetch(request))
						: remoteMcp.fetch(request);
				},
				{ parse: "none" },
			);
	}
	// /api/* precedence over the staff fallback is load-bearing and router-level specific.
	app.all(
		"/api/*",
		({ request, server }) => {
			attachRequestServer(merchant, server);
			return merchantRequestScope === undefined
				? merchant.fetch(request)
				: merchantRequestScope.run(request, () => merchant.fetch(request));
		},
		{ parse: "none" },
	);
	app.all(
		"/*",
		({ request, server }) => {
			attachRequestServer(staff, server);
			return staffRequestScope === undefined
				? staff.fetch(request)
				: staffRequestScope.run(request, () => staff.fetch(request));
		},
		{ parse: "none" },
	);
	return {
		fetch(request, server) {
			attachRequestServer(app, server);
			return app.fetch(request);
		},
	};
}
