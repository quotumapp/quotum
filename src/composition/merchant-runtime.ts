import type { BetterAuthOptions } from "better-auth";
import { Hono } from "hono";
import type { BillingHonoEnv } from "../app/types";
import { sql } from "../db/client";
import { createMerchantApp } from "../platform/app";
import type { MerchantBillingPort } from "../platform/application/billing-port";
import { createMerchantAuth, type MerchantAuth } from "../platform/auth";
import { createMerchantBilling } from "../platform/billing";
import { loadMerchantConfig, type MerchantConfig } from "../platform/config";
import { MerchantStripeOAuth } from "../platform/connections/oauth";
import { MerchantConnections } from "../platform/connections/service";
import { CloudflareMerchantMailer, type MerchantMailer } from "../platform/email";
import { MerchantStore } from "../platform/store";
import { createConnectionEventApp } from "./connection-events";
import { createConnectionValidation } from "./connection-validation";
import { createConnectionRepository } from "./connections";
import { createEnvironmentBillingPort } from "./environment-billing";
import { merchantAuthDatabase, merchantSql } from "./merchant-persistence";
import { createStripeAppEvents } from "./stripe-app-events";
import { createStripeOAuthPort } from "./stripe-oauth";

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
	staff: Hono<BillingHonoEnv>,
	billing: MerchantBillingPort,
	options: MerchantRuntimeOptions = {},
): Hono {
	const config = options.config ?? loadMerchantConfig();
	if (!config) return new Hono().all("*", (c) => staff.fetch(c.req.raw));
	const store = new MerchantStore(merchantSql(sql), config);
	const mailer =
		options.mailer ?? (config.email ? new CloudflareMerchantMailer(config.email) : null);
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
	const app = new Hono();
	app.route("/", createConnectionEventApp(repository));
	if (oauth) {
		const events = createStripeAppEvents(repository, oauth);
		app.route("/", events.app);
		options.registerBackground?.(events);
	}
	app.all("/api/*", (c) => merchant.fetch(c.req.raw));
	app.all("*", (c) => staff.fetch(c.req.raw));
	return app;
}
