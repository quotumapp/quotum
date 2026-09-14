import type { BetterAuthOptions } from "better-auth";
import { Elysia } from "elysia";
import { sql } from "../db/client";
import { attachRequestServer } from "../http/server";
import { createMerchantApp } from "../platform/app";
import type { MerchantBillingPort } from "../platform/application/billing-port";
import { createMerchantAuth, type MerchantAuth } from "../platform/auth";
import { createMerchantBilling } from "../platform/billing";
import type { MerchantConfig } from "../platform/config";
import { MerchantStripeOAuth } from "../platform/connections/oauth";
import { MerchantConnections } from "../platform/connections/service";
import { createMerchantMailer, type MerchantMailer } from "../platform/email";
import { MerchantStore } from "../platform/store";
import { type AppElysia, HTTP_APP_CONFIG } from "../shared/http";
import { createConnectionEventApp } from "./connection-events";
import { createConnectionValidation } from "./connection-validation";
import { createConnectionRepository } from "./connections";
import { createEnvironmentBillingPort } from "./environment-billing";
import { merchantAuthDatabase, merchantSql } from "./merchant-persistence";
import type { QuotumApp } from "./runtime-lifecycle";
import { createStripeAppEvents } from "./stripe-app-events";
import { createStripeOAuthPort } from "./stripe-oauth";

/** Wraps one staff dispatch, e.g. in the Sentry isolation scope the staff app's hooks tag. */
export interface StaffRequestScope {
	run<T>(request: Request, dispatch: () => T): T;
}

export interface MerchantRuntimeOptions {
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
		staffRequestScope?: StaffRequestScope;
	},
): QuotumApp {
	const { config } = options;
	const store = new MerchantStore(merchantSql(sql), config);
	const mailer = options.mailer ?? (config.email ? createMerchantMailer(config.email) : null);
	if (!mailer)
		throw new Error("Merchant email transport is required; tests must inject a capture mailer");
	const database = merchantAuthDatabase(sql);
	const repository = createConnectionRepository();
	const validator = createConnectionValidation();
	const oauth = createStripeOAuthPort();
	const connections = new MerchantConnections(
		store,
		repository,
		validator,
		createEnvironmentBillingPort(),
		oauth,
	);
	const merchant = createMerchantApp({
		store,
		connections,
		stripeOAuth: oauth
			? new MerchantStripeOAuth(store, connections, repository, oauth, validator)
			: undefined,
		mailer,
		auth: (options.createAuth ?? createMerchantAuth)(store, mailer, database),
		billing: createMerchantBilling(store, billing),
	});
	const ingress = [createConnectionEventApp(repository)];
	if (oauth) {
		const events = createStripeAppEvents(repository, oauth);
		ingress.push(events.app);
		options.registerBackground?.(events);
	}
	return composeRuntimeApp({
		staff,
		merchant,
		ingress,
		staffRequestScope: options.staffRequestScope,
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
	staffRequestScope?: StaffRequestScope;
}): QuotumApp {
	const { staff, merchant, staffRequestScope } = input;
	const app = new Elysia(HTTP_APP_CONFIG);
	for (const ingress of input.ingress ?? []) app.use(ingress);
	// /api/* precedence over the staff fallback is load-bearing and router-level specific.
	app.all(
		"/api/*",
		({ request, server }) => {
			attachRequestServer(merchant, server);
			return merchant.fetch(request);
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
