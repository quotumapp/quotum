import type { BetterAuthOptions } from "better-auth";
import { Hono } from "hono";
import type { BillingHonoEnv } from "../app/types";
import { sql } from "../db/client";
import { createMerchantApp } from "../platform/app";
import type { MerchantBillingPort } from "../platform/application/billing-port";
import { createMerchantAuth, type MerchantAuth } from "../platform/auth";
import { createMerchantBilling } from "../platform/billing";
import { loadMerchantConfig, type MerchantConfig } from "../platform/config";
import { CloudflareMerchantMailer, type MerchantMailer } from "../platform/email";
import { MerchantStore } from "../platform/store";
import { merchantAuthDatabase, merchantSql } from "./merchant-persistence";

export interface MerchantRuntimeOptions {
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
	const merchant = createMerchantApp({
		store,
		mailer,
		auth: (options.createAuth ?? createMerchantAuth)(store, mailer, database),
		billing: createMerchantBilling(store, billing),
	});
	const app = new Hono();
	app.all("/api/*", (c) => merchant.fetch(c.req.raw));
	app.all("*", (c) => staff.fetch(c.req.raw));
	return app;
}
