import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

let context: LocalPostgresContext;
describeLocalPostgres(describe, describe.skip)("documented Stripe gateway failures", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(() => resetAndSeedIntegrationData(context.sql));
	afterAll(() => context.sql.close());
	it.each(["hosted", "embedded", "setup"] as const)(
		"documents the %s checkout 502 through HTTP",
		async (mode) => {
			const { app, stripe, authHeaders } = createIntegrationApp({
				env: context.env,
				repository: context.repository,
			});
			stripe.client.createCheckoutSession = async (params) =>
				params.ui_mode === "embedded_page"
					? { id: "cs_missing_fields", url: null, client_secret: "" }
					: { id: "cs_missing_fields", url: "" };
			const headers = {
				...authHeaders("acme"),
				"content-type": "application/json",
				"idempotency-key": `gateway-${mode}`,
				"x-request-id": `gateway-${mode}`,
			};
			let path = "/v1/billing-accounts/gateway-account/providers/stripe/checkout-sessions";
			let body: object = {
				productKey: "echo_credits_10",
				...(mode === "embedded" ? { uiMode: "embedded" } : {}),
			};
			if (mode === "setup") {
				const preview = await testRequest(
					app,
					"/v1/billing-accounts/gateway-account/commercial-actions/preview",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ intent: { kind: "setup_payment", currency: "USD" } }),
					},
				);
				expect(preview.status).toBe(200);
				const data = (await preview.json()).data;
				path = "/v1/billing-accounts/gateway-account/commercial-actions";
				body = { previewToken: data.previewToken };
			}
			const response = await testRequest(app, path, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(502);
			expect(await response.json()).toMatchObject({
				success: false,
				error: {
					code:
						mode === "embedded"
							? "STRIPE_CHECKOUT_CLIENT_SECRET_MISSING"
							: "STRIPE_CHECKOUT_URL_MISSING",
					requestId: `gateway-${mode}`,
				},
			});
		},
	);
});
